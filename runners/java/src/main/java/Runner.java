// XDRParity Java runner. Contract: ../contract.md — fixture input JSON on
// stdin, {tx_xdr, sig_payload_hash, error} on stdout, logs on stderr,
// exit 0 even on fixture errors.
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.io.StringReader;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.stellar.sdk.Account;
import org.stellar.sdk.Address;
import org.stellar.sdk.Asset;
import org.stellar.sdk.ChangeTrustAsset;
import org.stellar.sdk.Claimant;
import org.stellar.sdk.KeyPair;
import org.stellar.sdk.Memo;
import org.stellar.sdk.Network;
import org.stellar.sdk.Predicate;
import org.stellar.sdk.TimeBounds;
import org.stellar.sdk.Transaction;
import org.stellar.sdk.TransactionBuilder;
import org.stellar.sdk.TransactionPreconditions;
import org.stellar.sdk.operations.ChangeTrustOperation;
import org.stellar.sdk.operations.CreateAccountOperation;
import org.stellar.sdk.operations.CreateClaimableBalanceOperation;
import org.stellar.sdk.operations.InvokeHostFunctionOperation;
import org.stellar.sdk.operations.Operation;
import org.stellar.sdk.operations.PaymentOperation;
import org.stellar.sdk.operations.SetOptionsOperation;
import org.stellar.sdk.scval.Scv;
import org.stellar.sdk.xdr.HostFunction;
import org.stellar.sdk.xdr.HostFunctionType;
import org.stellar.sdk.xdr.Int64;
import org.stellar.sdk.xdr.InvokeContractArgs;
import org.stellar.sdk.xdr.SCSymbol;
import org.stellar.sdk.xdr.SCVal;
import org.stellar.sdk.xdr.SorobanAddressCredentials;
import org.stellar.sdk.xdr.SorobanAuthorizationEntry;
import org.stellar.sdk.xdr.SorobanAuthorizedFunction;
import org.stellar.sdk.xdr.SorobanAuthorizedFunctionType;
import org.stellar.sdk.xdr.SorobanAuthorizedInvocation;
import org.stellar.sdk.xdr.SorobanCredentials;
import org.stellar.sdk.xdr.SorobanCredentialsType;
import org.stellar.sdk.xdr.Uint32;
import org.stellar.sdk.xdr.XdrString;
import org.stellar.sdk.xdr.XdrUnsignedInteger;

public final class Runner {
  private static final Pattern AMOUNT_RE = Pattern.compile("^(0|[1-9][0-9]*)\\.[0-9]{7}$");
  private static final Pattern SEQ_RE = Pattern.compile("^[1-9][0-9]*$");
  private static final Pattern MEMO_ID_RE = Pattern.compile("^(0|[1-9][0-9]*)$");
  private static final Set<String> OP_TYPES = Set.of("payment", "create_account", "change_trust",
      "set_options", "create_claimable_balance", "invoke_contract");
  private static final Gson GSON = new GsonBuilder().serializeNulls().disableHtmlEscaping().create();

  private static final class StageException extends RuntimeException {
    final String stage;
    StageException(String stage, String message) { super(message); this.stage = stage; }
  }

  private static StageException parseErr(String message) {
    return new StageException("parse", message);
  }

  /** The normative parse checklist from contract.md — this, and nothing more. */
  private static void validate(JsonObject req) {
    for (String key : new String[] {"fixture_id", "network_passphrase", "tx", "signers"}) {
      if (!req.has(key)) throw parseErr("missing required field " + key);
    }
    JsonObject tx = req.getAsJsonObject("tx");
    for (String key : new String[] {"source_account", "seq_num", "fee", "time_bounds", "memo", "operations"}) {
      if (!tx.has(key)) throw parseErr("missing required field tx." + key);
    }
    JsonElement seqEl = tx.get("seq_num");
    String seq = seqEl.isJsonPrimitive() && seqEl.getAsJsonPrimitive().isString() ? seqEl.getAsString() : null;
    if (seq == null || !SEQ_RE.matcher(seq).matches()
        || new BigInteger(seq).compareTo(BigInteger.TWO.pow(63).subtract(BigInteger.ONE)) > 0) {
      throw parseErr("seq_num outside grammar/range: " + seqEl);
    }
    JsonObject tb = tx.getAsJsonObject("time_bounds");
    if (!tb.has("min_time") || !tb.has("max_time")
        || tb.get("min_time").getAsLong() > tb.get("max_time").getAsLong()) {
      throw parseErr("time_bounds missing, partial, or unordered");
    }
    JsonObject memo = tx.getAsJsonObject("memo");
    String memoType = memo.has("type") ? memo.get("type").getAsString() : "";
    switch (memoType) {
      case "none" -> { }
      case "text", "id", "hash", "return" -> {
        if (!memo.has("value")) throw parseErr("memo of type " + memoType + " is missing value");
        if (memoType.equals("text")
            && memo.get("value").getAsString().getBytes(StandardCharsets.UTF_8).length > 28) {
          throw parseErr("memo text exceeds 28 UTF-8 bytes");
        }
      }
      default -> throw parseErr("unknown memo type: " + memoType);
    }
    if (!req.get("signers").isJsonArray()) throw parseErr("signers is not an array");
    for (JsonElement sEl : req.getAsJsonArray("signers")) {
      if (!sEl.isJsonObject() || !sEl.getAsJsonObject().has("label")
          || !sEl.getAsJsonObject().has("secret_seed")) {
        throw parseErr("signers[] entry missing label or secret_seed");
      }
    }
    if (memoType.equals("id") && !MEMO_ID_RE.matcher(memo.get("value").getAsString()).matches()) {
      throw parseErr("memo id outside grammar: " + memo.get("value"));
    }
    for (JsonElement opEl : tx.getAsJsonArray("operations")) {
      JsonObject op = opEl.getAsJsonObject();
      String type = op.has("type") ? op.get("type").getAsString() : "";
      if (!OP_TYPES.contains(type)) throw parseErr("unknown operation type: " + type);
      for (String k : new String[] {"amount", "starting_balance", "limit"}) {
        if (op.has(k) && !AMOUNT_RE.matcher(op.get(k).getAsString()).matches()) {
          throw parseErr("amount grammar violation in " + k + ": " + op.get(k));
        }
      }
    }
  }

  private static Asset buildAsset(JsonObject a) {
    return a.get("type").getAsString().equals("native")
        ? Asset.create("native")
        : Asset.createNonNativeAsset(a.get("code").getAsString(), a.get("issuer").getAsString());
  }

  private static Memo buildMemo(JsonObject m) {
    return switch (m.get("type").getAsString()) {
      case "text" -> Memo.text(m.get("value").getAsString());
      case "id" -> Memo.id(new BigInteger(m.get("value").getAsString()));
      case "hash" -> Memo.hash(HexFormat.of().parseHex(m.get("value").getAsString()));
      case "return" -> Memo.returnHash(HexFormat.of().parseHex(m.get("value").getAsString()));
      default -> Memo.none();
    };
  }

  private static SCVal scVal(JsonElement el) {
    JsonObject v = el.getAsJsonObject();
    if (v.size() != 1) throw new IllegalArgumentException("ScVal is not a single-key map: " + v);
    String tag = v.keySet().iterator().next();
    JsonElement val = v.get(tag);
    return switch (tag) {
      case "u32" -> Scv.toUint32(val.getAsLong());
      case "i128" -> Scv.toInt128(new BigInteger(val.getAsString()));
      case "symbol" -> Scv.toSymbol(val.getAsString());
      case "address" -> Scv.toAddress(val.getAsString());
      case "vec" -> {
        List<SCVal> items = new ArrayList<>();
        for (JsonElement item : val.getAsJsonArray()) items.add(scVal(item));
        yield Scv.toVec(items);
      }
      case "void" -> Scv.toVoid();
      default -> throw new IllegalArgumentException("unknown ScVal tag: " + tag);
    };
  }

  private static InvokeContractArgs contractArgs(String contract, String function, JsonArray args) {
    List<SCVal> params = new ArrayList<>();
    for (JsonElement a : args) params.add(scVal(a));
    return InvokeContractArgs.builder()
        .contractAddress(new Address(contract).toSCAddress())
        .functionName(new SCSymbol(new XdrString(function)))
        .args(params.toArray(new SCVal[0]))
        .build();
  }

  private static SorobanAuthorizedInvocation buildInvocation(JsonObject inv) {
    List<SorobanAuthorizedInvocation> subs = new ArrayList<>();
    for (JsonElement s : inv.getAsJsonArray("sub_invocations")) subs.add(buildInvocation(s.getAsJsonObject()));
    return SorobanAuthorizedInvocation.builder()
        .function(SorobanAuthorizedFunction.builder()
            .discriminant(SorobanAuthorizedFunctionType.SOROBAN_AUTHORIZED_FUNCTION_TYPE_CONTRACT_FN)
            .contractFn(contractArgs(inv.get("contract").getAsString(),
                inv.get("function").getAsString(), inv.getAsJsonArray("args")))
            .build())
        .subInvocations(subs.toArray(new SorobanAuthorizedInvocation[0]))
        .build();
  }

  private static SorobanAuthorizationEntry buildAuth(JsonObject a) {
    JsonElement credEl = a.get("credentials");
    SorobanCredentials credentials;
    if (credEl.isJsonPrimitive() && credEl.getAsString().equals("source_account")) {
      credentials = SorobanCredentials.builder()
          .discriminant(SorobanCredentialsType.SOROBAN_CREDENTIALS_SOURCE_ACCOUNT).build();
    } else {
      JsonObject c = credEl.getAsJsonObject();
      credentials = SorobanCredentials.builder()
          .discriminant(SorobanCredentialsType.SOROBAN_CREDENTIALS_ADDRESS)
          .address(SorobanAddressCredentials.builder()
              .address(new Address(c.get("address").getAsString()).toSCAddress())
              .nonce(new Int64(c.get("nonce").getAsLong()))
              .signatureExpirationLedger(
                  new Uint32(new XdrUnsignedInteger(c.get("signature_expiration_ledger").getAsLong())))
              .signature(Scv.toVoid()) // committed unsigned (schema.md)
              .build())
          .build();
    }
    return SorobanAuthorizationEntry.builder()
        .credentials(credentials)
        .rootInvocation(buildInvocation(a.getAsJsonObject("invocation")))
        .build();
  }

  private static Operation buildOp(JsonObject op) {
    String source = op.has("source") ? op.get("source").getAsString() : null;
    Operation built = switch (op.get("type").getAsString()) {
      case "payment" -> PaymentOperation.builder()
          .destination(op.get("destination").getAsString())
          .asset(buildAsset(op.getAsJsonObject("asset")))
          .amount(new BigDecimal(op.get("amount").getAsString()))
          .build();
      case "create_account" -> CreateAccountOperation.builder()
          .destination(op.get("destination").getAsString())
          .startingBalance(new BigDecimal(op.get("starting_balance").getAsString()))
          .build();
      case "change_trust" -> ChangeTrustOperation.builder()
          .asset(new ChangeTrustAsset(buildAsset(op.getAsJsonObject("asset"))))
          .limit(new BigDecimal(op.get("limit").getAsString()))
          .build();
      case "set_options" -> {
        SetOptionsOperation.SetOptionsOperationBuilder<?, ?> b = SetOptionsOperation.builder();
        if (op.has("master_weight")) b.masterKeyWeight(op.get("master_weight").getAsInt());
        if (op.has("low_threshold")) b.lowThreshold(op.get("low_threshold").getAsInt());
        if (op.has("med_threshold")) b.mediumThreshold(op.get("med_threshold").getAsInt());
        if (op.has("high_threshold")) b.highThreshold(op.get("high_threshold").getAsInt());
        if (op.has("home_domain")) b.homeDomain(op.get("home_domain").getAsString());
        if (op.has("signer")) {
          JsonObject s = op.getAsJsonObject("signer");
          b.signer(org.stellar.sdk.SignerKey.fromEd25519PublicKey(s.get("key").getAsString()));
          b.signerWeight(s.get("weight").getAsInt());
        }
        yield b.build();
      }
      case "create_claimable_balance" -> {
        List<Claimant> claimants = new ArrayList<>();
        for (JsonElement cEl : op.getAsJsonArray("claimants")) {
          JsonObject c = cEl.getAsJsonObject();
          JsonElement p = c.get("predicate");
          Predicate pred = p.isJsonPrimitive() && p.getAsString().equals("unconditional")
              ? new Predicate.Unconditional()
              : new Predicate.AbsBefore(p.getAsJsonObject().get("abs_before").getAsLong());
          claimants.add(new Claimant(c.get("destination").getAsString(), pred));
        }
        yield CreateClaimableBalanceOperation.builder()
            .asset(buildAsset(op.getAsJsonObject("asset")))
            .amount(new BigDecimal(op.get("amount").getAsString()))
            .claimants(claimants)
            .build();
      }
      case "invoke_contract" -> {
        List<SorobanAuthorizationEntry> auth = new ArrayList<>();
        for (JsonElement a : op.getAsJsonArray("auth")) auth.add(buildAuth(a.getAsJsonObject()));
        yield InvokeHostFunctionOperation.builder()
            .hostFunction(HostFunction.builder()
                .discriminant(HostFunctionType.HOST_FUNCTION_TYPE_INVOKE_CONTRACT)
                .invokeContract(contractArgs(op.get("contract").getAsString(),
                    op.get("function").getAsString(), op.getAsJsonArray("args")))
                .build())
            .auth(auth)
            .build();
      }
      default -> throw new IllegalStateException("unreachable");
    };
    if (source != null) built.setSourceAccount(source);
    return built;
  }

  private static Transaction build(JsonObject req) {
    JsonObject tx = req.getAsJsonObject("tx");
    JsonArray ops = tx.getAsJsonArray("operations");
    long fee = tx.get("fee").getAsLong();
    if (ops.isEmpty() || fee % ops.size() != 0) {
      throw new StageException("build", "fee " + fee + " not divisible by operation count " + ops.size());
    }
    // SDK builders take current sequence and auto-increment: feed seq_num - 1.
    Account source = new Account(tx.get("source_account").getAsString(),
        Long.parseLong(tx.get("seq_num").getAsString()) - 1);
    JsonObject tb = tx.getAsJsonObject("time_bounds");
    TransactionBuilder builder = new TransactionBuilder(source,
        new Network(req.get("network_passphrase").getAsString()))
        .setBaseFee(fee / ops.size()) // per-op base fee × n = fixture total
        .addPreconditions(TransactionPreconditions.builder()
            .timeBounds(new TimeBounds(tb.get("min_time").getAsLong(), tb.get("max_time").getAsLong()))
            .build())
        .addMemo(buildMemo(tx.getAsJsonObject("memo")));
    for (JsonElement op : ops) builder.addOperation(buildOp(op.getAsJsonObject()));
    Transaction built = builder.build();
    built.hash(); // flush any lazy XDR validation while still in the build stage
    return built;
  }

  public static void main(String[] args) throws Exception {
    String raw = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
    String stage = "parse";
    JsonObject out = new JsonObject();
    try {
      JsonObject req;
      try {
        JsonReader reader = new JsonReader(new StringReader(raw));
        reader.setStrictness(Strictness.STRICT);
        req = JsonParser.parseReader(reader).getAsJsonObject();
      } catch (JsonSyntaxException | IllegalStateException e) {
        throw parseErr("stdin is not valid JSON: " + e.getMessage());
      }
      validate(req);
      stage = "build";
      Transaction tx = build(req);
      stage = "sign";
      for (JsonElement s : req.getAsJsonArray("signers")) {
        tx.sign(KeyPair.fromSecretSeed(s.getAsJsonObject().get("secret_seed").getAsString()));
      }
      out.addProperty("tx_xdr", tx.toEnvelopeXdrBase64());
      out.addProperty("sig_payload_hash", HexFormat.of().formatHex(tx.hash()));
      out.add("error", null);
    } catch (Exception e) {
      String st = e instanceof StageException se ? se.stage : stage;
      System.err.println("[java-runner] " + st + " error: " + e);
      out.add("tx_xdr", null);
      out.add("sig_payload_hash", null);
      JsonObject err = new JsonObject();
      err.addProperty("stage", st);
      err.addProperty("message", String.valueOf(e.getMessage()));
      out.add("error", err);
    }
    // Explicit UTF-8 stdout — the platform default (Cp1252 on Windows) would
    // corrupt non-ASCII bytes in the contract JSON.
    PrintStream stdout = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    stdout.println(GSON.toJson(out));
  }
}
