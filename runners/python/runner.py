#!/usr/bin/env python3
"""XDRParity Python runner. Contract: ../contract.md — fixture input JSON on
stdin, {tx_xdr, sig_payload_hash, error} on stdout, logs on stderr, exit 0
even on fixture errors."""
import json
import re
import sys

from stellar_sdk import (Account, Asset, Claimant, ClaimPredicate, Keypair,
                         Signer, TransactionBuilder, scval)
from stellar_sdk import xdr as sxdr
from stellar_sdk.address import Address

AMOUNT_RE = re.compile(r"^(0|[1-9][0-9]*)\.[0-9]{7}$")
SEQ_RE = re.compile(r"^[1-9][0-9]*$")
MEMO_ID_RE = re.compile(r"^(0|[1-9][0-9]*)$")
OP_TYPES = {"payment", "create_account", "change_trust", "set_options",
            "create_claimable_balance", "invoke_contract"}
MAX_I64 = 2**63 - 1


class StageError(Exception):
    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


def parse_err(message: str) -> StageError:
    return StageError("parse", message)


def validate(req: dict) -> None:
    """The normative parse checklist from contract.md — this, and nothing more."""
    for key in ("fixture_id", "network_passphrase", "tx", "signers"):
        if key not in req:
            raise parse_err(f"missing required field {key}")
    tx = req["tx"]
    for key in ("source_account", "seq_num", "fee", "time_bounds", "memo", "operations"):
        if key not in tx:
            raise parse_err(f"missing required field tx.{key}")
    seq = tx["seq_num"]
    if not isinstance(seq, str) or not SEQ_RE.match(seq) or int(seq) > MAX_I64:
        raise parse_err(f"seq_num outside grammar/range: {seq!r}")
    tb = tx["time_bounds"]
    if not (isinstance(tb.get("min_time"), int) and isinstance(tb.get("max_time"), int)
            and tb["min_time"] <= tb["max_time"]):
        raise parse_err("time_bounds missing, partial, or unordered")
    memo = tx["memo"]
    if memo.get("type") not in {"none", "text", "id", "hash", "return"}:
        raise parse_err(f"unknown memo type: {memo.get('type')}")
    if memo.get("type") != "none" and "value" not in memo:
        raise parse_err(f"memo of type {memo['type']} is missing value")
    if memo.get("type") == "text" and len(str(memo["value"]).encode("utf-8")) > 28:
        raise parse_err("memo text exceeds 28 UTF-8 bytes")
    if memo.get("type") == "id" and not MEMO_ID_RE.match(str(memo["value"])):
        raise parse_err(f"memo id outside grammar: {memo['value']!r}")
    if not isinstance(req["signers"], list) or not all(
            isinstance(s, dict) and isinstance(s.get("label"), str)
            and isinstance(s.get("secret_seed"), str) for s in req["signers"]):
        raise parse_err("signers[] entry missing label or secret_seed")
    for op in tx["operations"]:
        if op.get("type") not in OP_TYPES:
            raise parse_err(f"unknown operation type: {op.get('type')}")
        for k in ("amount", "starting_balance", "limit"):
            if k in op and not AMOUNT_RE.match(str(op[k])):
                raise parse_err(f"amount grammar violation in {k}: {op[k]!r}")


def build_asset(a: dict) -> Asset:
    return Asset.native() if a["type"] == "native" else Asset(a["code"], a["issuer"])


def sc_val(v: dict) -> sxdr.SCVal:
    ((tag, val),) = v.items()
    if tag == "u32":
        return scval.to_uint32(val)
    if tag == "i128":
        return scval.to_int128(int(val))
    if tag == "symbol":
        return scval.to_symbol(val)
    if tag == "address":
        return scval.to_address(val)
    if tag == "vec":
        return scval.to_vec([sc_val(x) for x in val])
    if tag == "void":
        return scval.to_void()
    raise ValueError(f"unknown ScVal tag: {tag}")


def build_invocation(inv: dict) -> sxdr.SorobanAuthorizedInvocation:
    return sxdr.SorobanAuthorizedInvocation(
        function=sxdr.SorobanAuthorizedFunction(
            type=sxdr.SorobanAuthorizedFunctionType.SOROBAN_AUTHORIZED_FUNCTION_TYPE_CONTRACT_FN,
            contract_fn=sxdr.InvokeContractArgs(
                contract_address=Address(inv["contract"]).to_xdr_sc_address(),
                function_name=sxdr.SCSymbol(inv["function"].encode("utf-8")),
                args=[sc_val(a) for a in inv["args"]],
            ),
        ),
        sub_invocations=[build_invocation(s) for s in inv["sub_invocations"]],
    )


def build_auth(a: dict) -> sxdr.SorobanAuthorizationEntry:
    cred = a["credentials"]
    if cred == "source_account":
        credentials = sxdr.SorobanCredentials(
            type=sxdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT)
    else:
        credentials = sxdr.SorobanCredentials(
            type=sxdr.SorobanCredentialsType.SOROBAN_CREDENTIALS_ADDRESS,
            address=sxdr.SorobanAddressCredentials(
                address=Address(cred["address"]).to_xdr_sc_address(),
                nonce=sxdr.Int64(int(cred["nonce"])),
                signature_expiration_ledger=sxdr.Uint32(cred["signature_expiration_ledger"]),
                signature=scval.to_void(),  # committed unsigned (schema.md)
            ),
        )
    return sxdr.SorobanAuthorizationEntry(
        credentials=credentials, root_invocation=build_invocation(a["invocation"]))


def build_predicate(p) -> ClaimPredicate:
    if p == "unconditional":
        return ClaimPredicate.predicate_unconditional()
    return ClaimPredicate.predicate_before_absolute_time(p["abs_before"])


def add_memo(b: TransactionBuilder, memo: dict) -> None:
    if memo["type"] == "text":
        b.add_text_memo(memo["value"])
    elif memo["type"] == "id":
        b.add_id_memo(int(memo["value"]))
    elif memo["type"] == "hash":
        b.add_hash_memo(bytes.fromhex(memo["value"]))
    elif memo["type"] == "return":
        b.add_return_hash_memo(bytes.fromhex(memo["value"]))


def add_op(b: TransactionBuilder, op: dict) -> None:
    src = op.get("source")
    t = op["type"]
    if t == "payment":
        b.append_payment_op(destination=op["destination"], asset=build_asset(op["asset"]),
                            amount=op["amount"], source=src)
    elif t == "create_account":
        b.append_create_account_op(destination=op["destination"],
                                   starting_balance=op["starting_balance"], source=src)
    elif t == "change_trust":
        b.append_change_trust_op(asset=build_asset(op["asset"]), limit=op["limit"], source=src)
    elif t == "set_options":
        signer = (Signer.ed25519_public_key(op["signer"]["key"], op["signer"]["weight"])
                  if "signer" in op else None)
        b.append_set_options_op(
            master_weight=op.get("master_weight"), low_threshold=op.get("low_threshold"),
            med_threshold=op.get("med_threshold"), high_threshold=op.get("high_threshold"),
            home_domain=op.get("home_domain"), signer=signer, source=src)
    elif t == "create_claimable_balance":
        claimants = [Claimant(destination=c["destination"], predicate=build_predicate(c["predicate"]))
                     for c in op["claimants"]]
        b.append_create_claimable_balance_op(asset=build_asset(op["asset"]), amount=op["amount"],
                                             claimants=claimants, source=src)
    else:  # invoke_contract (validate() guarantees the type set)
        b.append_invoke_contract_function_op(
            contract_id=op["contract"], function_name=op["function"],
            parameters=[sc_val(a) for a in op["args"]],
            auth=[build_auth(a) for a in op["auth"]], source=src)


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8")
    stage = "parse"
    try:
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as e:
            raise parse_err(f"stdin is not valid JSON: {e}")
        validate(req)
        stage = "build"
        tx = req["tx"]
        ops = tx["operations"]
        if not ops or tx["fee"] % len(ops) != 0:
            raise StageError("build", f"fee {tx['fee']} not divisible by operation count {len(ops)}")
        # SDK builders take current sequence and auto-increment: feed seq_num - 1.
        source = Account(tx["source_account"], int(tx["seq_num"]) - 1)
        b = TransactionBuilder(source_account=source,
                               network_passphrase=req["network_passphrase"],
                               base_fee=tx["fee"] // len(ops))  # per-op base fee × n = fixture total
        b.add_time_bounds(tx["time_bounds"]["min_time"], tx["time_bounds"]["max_time"])
        add_memo(b, tx["memo"])
        for op in ops:
            add_op(b, op)
        envelope = b.build()
        envelope.hash()  # flush any lazy XDR validation while still in the build stage
        stage = "sign"
        for s in req["signers"]:
            envelope.sign(Keypair.from_secret(s["secret_seed"]))
        print(json.dumps({"tx_xdr": envelope.to_xdr(),
                          "sig_payload_hash": envelope.hash().hex(),
                          "error": None}))
    except Exception as e:  # noqa: BLE001 — every failure becomes contract JSON
        st = e.stage if isinstance(e, StageError) else stage
        print(f"[python-runner] {st} error: {e!r}", file=sys.stderr)
        print(json.dumps({"tx_xdr": None, "sig_payload_hash": None,
                          "error": {"stage": st, "message": str(e)}}))


if __name__ == "__main__":
    sys.stderr.reconfigure(errors="replace")
    main()
