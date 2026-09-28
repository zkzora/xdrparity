#!/usr/bin/env node
// XDRParity JS runner. Contract: ../contract.md — fixture input JSON on
// stdin, {tx_xdr, sig_payload_hash, error} on stdout, logs on stderr,
// exit 0 even on fixture errors.
'use strict';
const fs = require('fs');
const S = require('@stellar/stellar-sdk');

const AMOUNT_RE = /^(0|[1-9][0-9]*)\.[0-9]{7}$/;
const SEQ_RE = /^[1-9][0-9]*$/;
const MEMO_ID_RE = /^(0|[1-9][0-9]*)$/;
const OP_TYPES = new Set(['payment', 'create_account', 'change_trust',
  'set_options', 'create_claimable_balance', 'invoke_contract']);

class StageError extends Error {
  constructor(stage, message) { super(message); this.stage = stage; }
}
const parseErr = (m) => new StageError('parse', m);

// The normative parse checklist from contract.md — this, and nothing more.
function validateInput(req) {
  const tx = req.tx;
  for (const [obj, key, where] of [
    [req, 'fixture_id', ''],
    [req, 'network_passphrase', ''], [req, 'tx', ''], [req, 'signers', ''],
    [tx, 'source_account', 'tx.'], [tx, 'seq_num', 'tx.'], [tx, 'fee', 'tx.'],
    [tx, 'time_bounds', 'tx.'], [tx, 'memo', 'tx.'], [tx, 'operations', 'tx.'],
  ]) {
    if (obj == null || obj[key] === undefined) throw parseErr(`missing required field ${where}${key}`);
  }
  if (typeof tx.seq_num !== 'string' || !SEQ_RE.test(tx.seq_num) || BigInt(tx.seq_num) > 2n ** 63n - 1n)
    throw parseErr(`seq_num outside grammar/range: ${JSON.stringify(tx.seq_num)}`);
  const tb = tx.time_bounds;
  if (typeof tb.min_time !== 'number' || typeof tb.max_time !== 'number'
      || !(tb.min_time <= tb.max_time))
    throw parseErr('time_bounds missing, partial, or unordered');
  const memo = tx.memo;
  if (!['none', 'text', 'id', 'hash', 'return'].includes(memo.type))
    throw parseErr(`unknown memo type: ${memo.type}`);
  if (memo.type !== 'none' && memo.value === undefined)
    throw parseErr(`memo of type ${memo.type} is missing value`);
  if (memo.type === 'text' && Buffer.byteLength(String(memo.value), 'utf8') > 28)
    throw parseErr('memo text exceeds 28 UTF-8 bytes');
  if (memo.type === 'id' && !MEMO_ID_RE.test(String(memo.value)))
    throw parseErr(`memo id outside grammar: ${memo.value}`);
  if (!Array.isArray(req.signers))
    throw parseErr('signers is not an array');
  for (const s of req.signers) {
    if (typeof s?.label !== 'string' || typeof s?.secret_seed !== 'string')
      throw parseErr('signers[] entry missing label or secret_seed');
  }
  for (const op of tx.operations) {
    if (!OP_TYPES.has(op.type)) throw parseErr(`unknown operation type: ${op.type}`);
    for (const k of ['amount', 'starting_balance', 'limit'])
      if (op[k] !== undefined && !AMOUNT_RE.test(op[k]))
        throw parseErr(`amount grammar violation in ${k}: ${JSON.stringify(op[k])}`);
  }
}

const buildAsset = (a) => a.type === 'native'
  ? S.Asset.native()
  : new S.Asset(a.code, a.issuer);

function buildMemo(m) {
  switch (m.type) {
    case 'none': return S.Memo.none();
    case 'text': return S.Memo.text(m.value);
    case 'id': return S.Memo.id(String(m.value));
    case 'hash': return S.Memo.hash(m.value);
    case 'return': return S.Memo.return(m.value);
  }
}

function scVal(v) {
  const [tag, val] = Object.entries(v)[0];
  switch (tag) {
    case 'u32': return S.xdr.ScVal.scvU32(val);
    case 'i128': return new S.XdrLargeInt('i128', val).toScVal();
    case 'symbol': return S.xdr.ScVal.scvSymbol(val);
    case 'address': return new S.Address(val).toScVal();
    case 'vec': return S.xdr.ScVal.scvVec(val.map(scVal));
    case 'void': return S.xdr.ScVal.scvVoid();
    default: throw new Error(`unknown ScVal tag: ${tag}`);
  }
}

function buildInvocation(inv) {
  return new S.xdr.SorobanAuthorizedInvocation({
    function: S.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new S.xdr.InvokeContractArgs({
        contractAddress: new S.Address(inv.contract).toScAddress(),
        functionName: inv.function,
        args: inv.args.map(scVal),
      })),
    subInvocations: inv.sub_invocations.map(buildInvocation),
  });
}

function buildAuthEntry(a) {
  let credentials;
  if (a.credentials === 'source_account') {
    credentials = S.xdr.SorobanCredentials.sorobanCredentialsSourceAccount();
  } else {
    const c = a.credentials;
    const addressCredentials = new S.xdr.SorobanAddressCredentials({
      address: new S.Address(c.address).toScAddress(),
      nonce: S.xdr.Int64.fromString(String(c.nonce)),
      signatureExpirationLedger: c.signature_expiration_ledger,
      signature: S.xdr.ScVal.scvVoid(),  // committed unsigned (schema.md)
    });
    if (c.type === 'address') {
      credentials = S.xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials);
    } else if (c.type === 'address_v2') {
      credentials = S.xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials);
    } else {
      throw new Error(`unknown credentials type: ${c.type}`);
    }
  }
  return new S.xdr.SorobanAuthorizationEntry({
    credentials, rootInvocation: buildInvocation(a.invocation),
  });
}

function buildOp(op) {
  const common = op.source !== undefined ? { source: op.source } : {};
  switch (op.type) {
    case 'payment':
      return S.Operation.payment({ ...common, destination: op.destination,
        asset: buildAsset(op.asset), amount: op.amount });
    case 'create_account':
      return S.Operation.createAccount({ ...common, destination: op.destination,
        startingBalance: op.starting_balance });
    case 'change_trust':
      return S.Operation.changeTrust({ ...common, asset: buildAsset(op.asset),
        limit: op.limit });
    case 'set_options':
      return S.Operation.setOptions({ ...common,
        masterWeight: op.master_weight, lowThreshold: op.low_threshold,
        medThreshold: op.med_threshold, highThreshold: op.high_threshold,
        homeDomain: op.home_domain,
        signer: op.signer && { ed25519PublicKey: op.signer.key, weight: op.signer.weight },
      });
    case 'create_claimable_balance':
      return S.Operation.createClaimableBalance({ ...common,
        asset: buildAsset(op.asset), amount: op.amount,
        claimants: op.claimants.map((c) => new S.Claimant(c.destination,
          c.predicate === 'unconditional'
            ? S.Claimant.predicateUnconditional()
            : S.Claimant.predicateBeforeAbsoluteTime(String(c.predicate.abs_before)))),
      });
    case 'invoke_contract':
      return S.Operation.invokeContractFunction({ ...common,
        contract: op.contract, function: op.function,
        args: op.args.map(scVal), auth: op.auth.map(buildAuthEntry) });
  }
}

function build(req) {
  const tx = req.tx;
  const nOps = tx.operations.length;
  if (nOps === 0 || tx.fee % nOps !== 0)
    throw new StageError('build', `fee ${tx.fee} not divisible by operation count ${nOps}`);
  // SDK builders take current sequence and auto-increment: feed seq_num - 1.
  const account = new S.Account(tx.source_account, (BigInt(tx.seq_num) - 1n).toString());
  const builder = new S.TransactionBuilder(account, {
    fee: String(tx.fee / nOps),  // per-op base fee × nOps = fixture total
    networkPassphrase: req.network_passphrase,
    timebounds: { minTime: tx.time_bounds.min_time, maxTime: tx.time_bounds.max_time },
    memo: buildMemo(tx.memo),
  });
  for (const op of tx.operations) builder.addOperation(buildOp(op));
  const built = builder.build();
  built.hash(); // flush the SDK's lazy XDR validation while still in the build stage
  return built;
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  let stage = 'parse';
  try {
    let req;
    try { req = JSON.parse(raw); } catch (e) { throw parseErr(`stdin is not valid JSON: ${e.message}`); }
    validateInput(req);
    stage = 'build';
    const tx = build(req);
    stage = 'sign';
    for (const s of req.signers) tx.sign(S.Keypair.fromSecret(s.secret_seed));
    process.stdout.write(JSON.stringify({
      tx_xdr: tx.toXdr(),
      sig_payload_hash: Buffer.from(tx.hash()).toString('hex'),
      error: null,
    }) + '\n');
  } catch (e) {
    const st = e instanceof StageError ? e.stage : stage;
    process.stderr.write(`[js-runner] ${st} error: ${e.stack || e}\n`);
    process.stdout.write(JSON.stringify({
      tx_xdr: null, sig_payload_hash: null,
      error: { stage: st, message: String(e.message || e) },
    }) + '\n');
  }
}

main();
