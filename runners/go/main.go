// XDRParity Go runner. Contract: ../contract.md — fixture input JSON on
// stdin, {tx_xdr, sig_payload_hash, error} on stdout, logs on stderr,
// exit 0 even on fixture errors.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"os"
	"regexp"
	"strconv"

	"github.com/stellar/go-stellar-sdk/keypair"
	"github.com/stellar/go-stellar-sdk/strkey"
	"github.com/stellar/go-stellar-sdk/txnbuild"
	"github.com/stellar/go-stellar-sdk/xdr"
)

var (
	amountRe = regexp.MustCompile(`^(0|[1-9][0-9]*)\.[0-9]{7}$`)
	seqRe    = regexp.MustCompile(`^[1-9][0-9]*$`)
	memoIDRe = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	opTypes  = map[string]bool{"payment": true, "create_account": true, "change_trust": true,
		"set_options": true, "create_claimable_balance": true, "invoke_contract": true}
)

type stageError struct{ stage, msg string }

func (e *stageError) Error() string { return e.msg }
func parseErr(format string, a ...any) *stageError {
	return &stageError{"parse", fmt.Sprintf(format, a...)}
}

type request struct {
	FixtureID         *string       `json:"fixture_id"`
	NetworkPassphrase *string       `json:"network_passphrase"`
	Tx                *txInput      `json:"tx"`
	Signers           []signerInput `json:"signers"`
}
type txInput struct {
	SourceAccount *string          `json:"source_account"`
	SeqNum        *json.RawMessage `json:"seq_num"`
	Fee           *int64           `json:"fee"`
	TimeBounds    *timeBounds      `json:"time_bounds"`
	Memo          *memoInput       `json:"memo"`
	Operations    *[]op            `json:"operations"`
}
type timeBounds struct {
	MinTime *int64 `json:"min_time"`
	MaxTime *int64 `json:"max_time"`
}
type memoInput struct {
	Type  string  `json:"type"`
	Value *string `json:"value"`
}
type signerInput struct {
	Label      *string `json:"label"`
	SecretSeed *string `json:"secret_seed"`
}
type op = map[string]json.RawMessage

func str(raw json.RawMessage) (string, bool) {
	var s string
	return s, json.Unmarshal(raw, &s) == nil
}

// validate implements the normative parse checklist from contract.md — this,
// and nothing more. Returns the seq_num as int64.
func validate(req *request) (int64, error) {
	switch {
	case req.FixtureID == nil:
		return 0, parseErr("missing required field fixture_id")
	case req.NetworkPassphrase == nil:
		return 0, parseErr("missing required field network_passphrase")
	case req.Tx == nil:
		return 0, parseErr("missing required field tx")
	case req.Signers == nil:
		return 0, parseErr("missing required field signers")
	}
	tx := req.Tx
	for name, missing := range map[string]bool{
		"source_account": tx.SourceAccount == nil, "seq_num": tx.SeqNum == nil,
		"fee": tx.Fee == nil, "time_bounds": tx.TimeBounds == nil,
		"memo": tx.Memo == nil, "operations": tx.Operations == nil,
	} {
		if missing {
			return 0, parseErr("missing required field tx.%s", name)
		}
	}
	seqStr, ok := str(*tx.SeqNum)
	if !ok || !seqRe.MatchString(seqStr) {
		return 0, parseErr("seq_num outside grammar/range: %s", *tx.SeqNum)
	}
	seq, err := strconv.ParseInt(seqStr, 10, 64)
	if err != nil {
		return 0, parseErr("seq_num outside grammar/range: %s", seqStr)
	}
	tb := tx.TimeBounds
	if tb.MinTime == nil || tb.MaxTime == nil || !(*tb.MinTime <= *tb.MaxTime) {
		return 0, parseErr("time_bounds missing, partial, or unordered")
	}
	switch tx.Memo.Type {
	case "none":
	case "text", "id", "hash", "return":
		if tx.Memo.Value == nil {
			return 0, parseErr("memo of type %s is missing value", tx.Memo.Type)
		}
		if tx.Memo.Type == "text" && len([]byte(*tx.Memo.Value)) > 28 { // Go strings are UTF-8 bytes
			return 0, parseErr("memo text exceeds 28 UTF-8 bytes")
		}
		if tx.Memo.Type == "id" && !memoIDRe.MatchString(*tx.Memo.Value) {
			return 0, parseErr("memo id outside grammar: %s", *tx.Memo.Value)
		}
	default:
		return 0, parseErr("unknown memo type: %s", tx.Memo.Type)
	}
	for _, s := range req.Signers {
		if s.Label == nil || s.SecretSeed == nil {
			return 0, parseErr("signers[] entry missing label or secret_seed")
		}
	}
	for _, o := range *tx.Operations {
		t, _ := str(o["type"])
		if !opTypes[t] {
			return 0, parseErr("unknown operation type: %s", t)
		}
		for _, k := range []string{"amount", "starting_balance", "limit"} {
			if raw, present := o[k]; present {
				if s, ok := str(raw); !ok || !amountRe.MatchString(s) {
					return 0, parseErr("amount grammar violation in %s: %s", k, raw)
				}
			}
		}
	}
	return seq, nil
}

func buildMemo(m *memoInput) (txnbuild.Memo, error) {
	switch m.Type {
	case "none":
		return nil, nil
	case "text":
		return txnbuild.MemoText(*m.Value), nil
	case "id":
		id, err := strconv.ParseUint(*m.Value, 10, 64) // unsigned: full uint64 range
		return txnbuild.MemoID(id), err
	case "hash", "return":
		raw, err := hex.DecodeString(*m.Value)
		if err != nil || len(raw) != 32 {
			return nil, fmt.Errorf("memo %s is not 32 hex bytes", m.Type)
		}
		var h [32]byte
		copy(h[:], raw)
		if m.Type == "hash" {
			return txnbuild.MemoHash(h), nil
		}
		return txnbuild.MemoReturn(h), nil
	}
	return nil, fmt.Errorf("unreachable memo type")
}

func buildAsset(raw json.RawMessage) (txnbuild.Asset, error) {
	var a struct{ Type, Code, Issuer string }
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, err
	}
	if a.Type == "native" {
		return txnbuild.NativeAsset{}, nil
	}
	return txnbuild.CreditAsset{Code: a.Code, Issuer: a.Issuer}, nil
}

var i128Bound = new(big.Int).Lsh(big.NewInt(1), 127)

func buildI128(s string) (xdr.Int128Parts, error) {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return xdr.Int128Parts{}, fmt.Errorf("i128 is not a decimal integer: %q", s)
	}
	max := new(big.Int).Sub(i128Bound, big.NewInt(1))
	min := new(big.Int).Neg(i128Bound)
	if v.Cmp(min) < 0 || v.Cmp(max) > 0 {
		return xdr.Int128Parts{}, fmt.Errorf("i128 out of range: %s", s)
	}
	twos := new(big.Int).And(
		new(big.Int).Add(v, new(big.Int).Lsh(big.NewInt(1), 128)),
		new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 128), big.NewInt(1)))
	mask64 := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 64), big.NewInt(1))
	lo := new(big.Int).And(twos, mask64).Uint64()
	hi := new(big.Int).Rsh(twos, 64).Uint64()
	return xdr.Int128Parts{Hi: xdr.Int64(int64(hi)), Lo: xdr.Uint64(lo)}, nil
}

func scAddress(s string) (xdr.ScAddress, error) {
	if strkey.IsValidContractAddress(s) {
		raw, err := strkey.Decode(strkey.VersionByteContract, s)
		if err != nil {
			return xdr.ScAddress{}, err
		}
		var h xdr.Hash
		copy(h[:], raw)
		cid := xdr.ContractId(h)
		return xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeContract, ContractId: &cid}, nil
	}
	aid := xdr.AccountId{}
	if err := aid.SetAddress(s); err != nil {
		return xdr.ScAddress{}, err
	}
	return xdr.ScAddress{Type: xdr.ScAddressTypeScAddressTypeAccount, AccountId: &aid}, nil
}

func buildScVal(raw json.RawMessage) (xdr.ScVal, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || len(m) != 1 {
		return xdr.ScVal{}, fmt.Errorf("ScVal is not a single-key map: %s", raw)
	}
	for tag, val := range m {
		switch tag {
		case "u32":
			var v uint32
			if err := json.Unmarshal(val, &v); err != nil {
				return xdr.ScVal{}, err
			}
			u := xdr.Uint32(v)
			return xdr.ScVal{Type: xdr.ScValTypeScvU32, U32: &u}, nil
		case "i128":
			s, _ := str(val)
			parts, err := buildI128(s)
			if err != nil {
				return xdr.ScVal{}, err
			}
			return xdr.ScVal{Type: xdr.ScValTypeScvI128, I128: &parts}, nil
		case "symbol":
			s, _ := str(val)
			sym := xdr.ScSymbol(s)
			return xdr.ScVal{Type: xdr.ScValTypeScvSymbol, Sym: &sym}, nil
		case "address":
			s, _ := str(val)
			addr, err := scAddress(s)
			if err != nil {
				return xdr.ScVal{}, err
			}
			return xdr.ScVal{Type: xdr.ScValTypeScvAddress, Address: &addr}, nil
		case "vec":
			var items []json.RawMessage
			if err := json.Unmarshal(val, &items); err != nil {
				return xdr.ScVal{}, err
			}
			vec := make(xdr.ScVec, len(items))
			for i, item := range items {
				sv, err := buildScVal(item)
				if err != nil {
					return xdr.ScVal{}, err
				}
				vec[i] = sv
			}
			p := &vec
			return xdr.ScVal{Type: xdr.ScValTypeScvVec, Vec: &p}, nil
		case "void":
			return xdr.ScVal{Type: xdr.ScValTypeScvVoid}, nil
		default:
			return xdr.ScVal{}, fmt.Errorf("unknown ScVal tag: %s", tag)
		}
	}
	return xdr.ScVal{}, fmt.Errorf("empty ScVal")
}

type invocationJSON struct {
	Contract       string            `json:"contract"`
	Function       string            `json:"function"`
	Args           []json.RawMessage `json:"args"`
	SubInvocations []invocationJSON  `json:"sub_invocations"`
}

func buildInvocation(inv invocationJSON) (xdr.SorobanAuthorizedInvocation, error) {
	args, err := buildScVals(inv.Args)
	if err != nil {
		return xdr.SorobanAuthorizedInvocation{}, err
	}
	contract, err := scAddress(inv.Contract)
	if err != nil {
		return xdr.SorobanAuthorizedInvocation{}, err
	}
	subs := make([]xdr.SorobanAuthorizedInvocation, len(inv.SubInvocations))
	for i, s := range inv.SubInvocations {
		if subs[i], err = buildInvocation(s); err != nil {
			return xdr.SorobanAuthorizedInvocation{}, err
		}
	}
	return xdr.SorobanAuthorizedInvocation{
		Function: xdr.SorobanAuthorizedFunction{
			Type: xdr.SorobanAuthorizedFunctionTypeSorobanAuthorizedFunctionTypeContractFn,
			ContractFn: &xdr.InvokeContractArgs{
				ContractAddress: contract,
				FunctionName:    xdr.ScSymbol(inv.Function),
				Args:            args,
			},
		},
		SubInvocations: subs,
	}, nil
}

func buildScVals(raws []json.RawMessage) ([]xdr.ScVal, error) {
	vals := make([]xdr.ScVal, len(raws))
	for i, r := range raws {
		v, err := buildScVal(r)
		if err != nil {
			return nil, err
		}
		vals[i] = v
	}
	return vals, nil
}

func buildAuth(raw json.RawMessage) (xdr.SorobanAuthorizationEntry, error) {
	var entry struct {
		Credentials json.RawMessage `json:"credentials"`
		Invocation  invocationJSON  `json:"invocation"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		return xdr.SorobanAuthorizationEntry{}, err
	}
	var creds xdr.SorobanCredentials
	if s, ok := str(entry.Credentials); ok && s == "source_account" {
		creds = xdr.SorobanCredentials{Type: xdr.SorobanCredentialsTypeSorobanCredentialsSourceAccount}
	} else {
		var c struct {
			Address                   string `json:"address"`
			Nonce                     int64  `json:"nonce"`
			SignatureExpirationLedger uint32 `json:"signature_expiration_ledger"`
		}
		if err := json.Unmarshal(entry.Credentials, &c); err != nil {
			return xdr.SorobanAuthorizationEntry{}, err
		}
		addr, err := scAddress(c.Address)
		if err != nil {
			return xdr.SorobanAuthorizationEntry{}, err
		}
		creds = xdr.SorobanCredentials{
			Type: xdr.SorobanCredentialsTypeSorobanCredentialsAddress,
			Address: &xdr.SorobanAddressCredentials{
				Address:                   addr,
				Nonce:                     xdr.Int64(c.Nonce),
				SignatureExpirationLedger: xdr.Uint32(c.SignatureExpirationLedger),
				Signature:                 xdr.ScVal{Type: xdr.ScValTypeScvVoid}, // committed unsigned
			},
		}
	}
	inv, err := buildInvocation(entry.Invocation)
	if err != nil {
		return xdr.SorobanAuthorizationEntry{}, err
	}
	return xdr.SorobanAuthorizationEntry{Credentials: creds, RootInvocation: inv}, nil
}

func buildOp(o op) (txnbuild.Operation, error) {
	t, _ := str(o["type"])
	source := ""
	if raw, present := o["source"]; present {
		source, _ = str(raw)
	}
	get := func(k string) string { s, _ := str(o[k]); return s }
	switch t {
	case "payment":
		asset, err := buildAsset(o["asset"])
		if err != nil {
			return nil, err
		}
		return &txnbuild.Payment{Destination: get("destination"), Amount: get("amount"),
			Asset: asset, SourceAccount: source}, nil
	case "create_account":
		return &txnbuild.CreateAccount{Destination: get("destination"),
			Amount: get("starting_balance"), SourceAccount: source}, nil
	case "change_trust":
		asset, err := buildAsset(o["asset"])
		if err != nil {
			return nil, err
		}
		line, err := asset.ToChangeTrustAsset()
		if err != nil {
			return nil, err
		}
		return &txnbuild.ChangeTrust{Line: line, Limit: get("limit"), SourceAccount: source}, nil
	case "set_options":
		so := &txnbuild.SetOptions{SourceAccount: source}
		var fields struct {
			MasterWeight  *uint8  `json:"master_weight"`
			LowThreshold  *uint8  `json:"low_threshold"`
			MedThreshold  *uint8  `json:"med_threshold"`
			HighThreshold *uint8  `json:"high_threshold"`
			HomeDomain    *string `json:"home_domain"`
			Signer        *struct {
				Key    string `json:"key"`
				Weight uint8  `json:"weight"`
			} `json:"signer"`
		}
		blob, _ := json.Marshal(o)
		if err := json.Unmarshal(blob, &fields); err != nil {
			return nil, err
		}
		if fields.MasterWeight != nil {
			so.MasterWeight = txnbuild.NewThreshold(txnbuild.Threshold(*fields.MasterWeight))
		}
		if fields.LowThreshold != nil {
			so.LowThreshold = txnbuild.NewThreshold(txnbuild.Threshold(*fields.LowThreshold))
		}
		if fields.MedThreshold != nil {
			so.MediumThreshold = txnbuild.NewThreshold(txnbuild.Threshold(*fields.MedThreshold))
		}
		if fields.HighThreshold != nil {
			so.HighThreshold = txnbuild.NewThreshold(txnbuild.Threshold(*fields.HighThreshold))
		}
		if fields.HomeDomain != nil {
			so.HomeDomain = txnbuild.NewHomeDomain(*fields.HomeDomain)
		}
		if fields.Signer != nil {
			so.Signer = &txnbuild.Signer{Address: fields.Signer.Key,
				Weight: txnbuild.Threshold(fields.Signer.Weight)}
		}
		return so, nil
	case "create_claimable_balance":
		asset, err := buildAsset(o["asset"])
		if err != nil {
			return nil, err
		}
		var claimants []struct {
			Destination string          `json:"destination"`
			Predicate   json.RawMessage `json:"predicate"`
		}
		if err := json.Unmarshal(o["claimants"], &claimants); err != nil {
			return nil, err
		}
		dests := make([]txnbuild.Claimant, len(claimants))
		for i, c := range claimants {
			var pred xdr.ClaimPredicate
			if s, ok := str(c.Predicate); ok && s == "unconditional" {
				pred = txnbuild.UnconditionalPredicate
			} else {
				var p struct {
					AbsBefore int64 `json:"abs_before"`
				}
				if err := json.Unmarshal(c.Predicate, &p); err != nil {
					return nil, err
				}
				pred = txnbuild.BeforeAbsoluteTimePredicate(p.AbsBefore)
			}
			dests[i] = txnbuild.NewClaimant(c.Destination, &pred)
		}
		return &txnbuild.CreateClaimableBalance{Asset: asset, Amount: get("amount"),
			Destinations: dests, SourceAccount: source}, nil
	case "invoke_contract":
		contract, err := scAddress(get("contract"))
		if err != nil {
			return nil, err
		}
		var argRaws []json.RawMessage
		if err := json.Unmarshal(o["args"], &argRaws); err != nil {
			return nil, err
		}
		args, err := buildScVals(argRaws)
		if err != nil {
			return nil, err
		}
		var authRaws []json.RawMessage
		if err := json.Unmarshal(o["auth"], &authRaws); err != nil {
			return nil, err
		}
		auth := make([]xdr.SorobanAuthorizationEntry, len(authRaws))
		for i, a := range authRaws {
			if auth[i], err = buildAuth(a); err != nil {
				return nil, err
			}
		}
		return &txnbuild.InvokeHostFunction{
			HostFunction: xdr.HostFunction{
				Type: xdr.HostFunctionTypeHostFunctionTypeInvokeContract,
				InvokeContract: &xdr.InvokeContractArgs{
					ContractAddress: contract,
					FunctionName:    xdr.ScSymbol(get("function")),
					Args:            args,
				},
			},
			Auth:          auth,
			SourceAccount: source,
		}, nil
	}
	return nil, fmt.Errorf("unreachable operation type %s", t)
}

func emit(txXdr, hash *string, stage, msg string) {
	out := map[string]any{"tx_xdr": txXdr, "sig_payload_hash": hash, "error": nil}
	if stage != "" {
		out["error"] = map[string]string{"stage": stage, "message": msg}
	}
	blob, _ := json.Marshal(out)
	fmt.Println(string(blob))
}

func run() (stage string, err error) {
	raw, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "parse", err
	}
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		return "parse", fmt.Errorf("stdin is not valid JSON: %w", err)
	}
	seq, verr := validate(&req)
	if verr != nil {
		return "parse", verr
	}
	stage = "build"
	tx := req.Tx
	ops := *tx.Operations
	if len(ops) == 0 || *tx.Fee%int64(len(ops)) != 0 {
		return stage, fmt.Errorf("fee %d not divisible by operation count %d", *tx.Fee, len(ops))
	}
	memo, err := buildMemo(tx.Memo)
	if err != nil {
		return stage, err
	}
	operations := make([]txnbuild.Operation, len(ops))
	for i, o := range ops {
		if operations[i], err = buildOp(o); err != nil {
			return stage, err
		}
	}
	// SDK builders take current sequence and auto-increment: feed seq_num - 1.
	built, err := txnbuild.NewTransaction(txnbuild.TransactionParams{
		SourceAccount:        &txnbuild.SimpleAccount{AccountID: *tx.SourceAccount, Sequence: seq - 1},
		IncrementSequenceNum: true,
		Operations:           operations,
		BaseFee:              *tx.Fee / int64(len(ops)), // per-op base fee × n = fixture total
		Memo:                 memo,
		Preconditions: txnbuild.Preconditions{
			TimeBounds: txnbuild.NewTimebounds(*tx.TimeBounds.MinTime, *tx.TimeBounds.MaxTime),
		},
	})
	if err != nil {
		return stage, err
	}
	if _, err := built.Base64(); err != nil { // flush XDR marshalling while still in the build stage
		return stage, err
	}
	stage = "sign"
	for _, s := range req.Signers {
		kp, err := keypair.ParseFull(*s.SecretSeed)
		if err != nil {
			return stage, err
		}
		if built, err = built.Sign(*req.NetworkPassphrase, kp); err != nil {
			return stage, err
		}
	}
	b64, err := built.Base64()
	if err != nil {
		return stage, err
	}
	hash, err := built.Hash(*req.NetworkPassphrase)
	if err != nil {
		return stage, err
	}
	hexHash := hex.EncodeToString(hash[:])
	emit(&b64, &hexHash, "", "")
	return "", nil
}

func main() {
	if stage, err := run(); err != nil {
		var se *stageError
		if ok := false; !ok {
			if e, isStage := err.(*stageError); isStage {
				se = e
			}
		}
		if se != nil {
			stage = se.stage
		}
		fmt.Fprintf(os.Stderr, "[go-runner] %s error: %v\n", stage, err)
		emit(nil, nil, stage, err.Error())
	}
}
