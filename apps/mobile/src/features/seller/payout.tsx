import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import type { PaymentBankView, PayoutAccountView } from "@market-runs/proto";
import {
  ApiError,
  getPayoutAccount,
  listBanks,
  maskAccountNumber,
  resolvePayoutAccount,
  revokePayoutAccount,
  savePayoutAccount,
} from "../../api";
import { Button, Card, Field, Label, Pill, colors, s } from "../../ui";

/**
 * The participant's payout account (GLOSSARY: settlement pays sellers and
 * runners out — this is the account their leg lands in). The account is ALWAYS
 * verified with the provider before saving: "Verify account" resolves the
 * number to a name (422 = unresolvable, never stored), the participant confirms
 * the NAME, and only then Save persists. The "change" path revokes, then re-adds.
 *
 * Shared by seller onboarding/home and runner home — one component, one
 * contract. Never blocks marketplace work: with no account the home shows a
 * gentle prompt card and the participant can continue.
 */
export function PayoutAccountCard({
  participantId,
  recipientRole = "seller",
  /** "prompt" (home): no account → gentle card behind a tap. "form" (join): straight into the form. */
  emptyState = "prompt",
  onSaved,
}: {
  participantId: string;
  recipientRole?: "seller" | "runner";
  emptyState?: "prompt" | "form";
  onSaved?: () => void;
}) {
  const [account, setAccount] = useState<PayoutAccountView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(emptyState === "form");

  const refresh = useCallback(async () => {
    try {
      setAccount(await getPayoutAccount(participantId));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoaded(true);
    }
  }, [participantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!loaded) {
    return (
      <Card>
        <Text style={s.muted}>Checking your payout account…</Text>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card style={{ borderColor: colors.orange }}>
        <Text style={s.body}>Payouts: {loadError}</Text>
        <Button title="Try again" secondary onPress={() => void refresh()} />
      </Card>
    );
  }

  if (account && !editing) {
    return (
      <Card>
        <Pill active>PAYOUTS READY</Pill>
        <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 16 }}>
          {account.accountName} — <BankName code={account.bankCode} /> {maskAccountNumber(account.accountNumber)}
        </Text>
        <Text style={s.muted}>Used for {recipientRole} payouts.</Text>
        <Button
          title="Change payout account"
          secondary
          onPress={async () => {
            // Change = revoke, then re-add — an unresolved account is never stored.
            await revokePayoutAccount(participantId).catch(() => undefined);
            setAccount(null);
            setEditing(true);
          }}
        />
      </Card>
    );
  }

  if (!editing) {
    return (
      <Card>
        <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 16 }}>Add a payout account</Text>
        <Text style={s.body}>A verified bank account is required to receive {recipientRole} payouts.</Text>
        <Button title="Add payout account" secondary onPress={() => setEditing(true)} />
      </Card>
    );
  }

  return (
    <PayoutAccountForm
      participantId={participantId}
      onSaved={async (saved) => {
        setAccount(saved);
        setEditing(false);
        onSaved?.();
      }}
      // exactOptionalPropertyTypes: omit the prop entirely when absent.
      {...(emptyState === "prompt" ? { onCancel: () => setEditing(false) } : {})}
    />
  );
}

/** Bank code → display name from the provider directory; falls back to the raw code. */
function BankName({ code }: { code: string }) {
  const [name, setName] = useState<string>(code);
  useEffect(() => {
    let live = true;
    listBanks()
      .then((items) => {
        const found = items.find((item) => item.code === code);
        if (live && found) setName(found.name);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [code]);
  return <>{name}</>;
}

function PayoutAccountForm({
  participantId,
  onSaved,
  onCancel,
}: {
  participantId: string;
  onSaved: (account: PayoutAccountView) => void;
  onCancel?: () => void;
}) {
  const [banks, setBanks] = useState<PaymentBankView[] | null>(null);
  const [banksError, setBanksError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [bank, setBank] = useState<PaymentBankView | null>(null);
  const [accountNumber, setAccountNumber] = useState("");
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    listBanks()
      .then((items) => setBanks(items.sort((a, b) => a.name.localeCompare(b.name))))
      .catch((error: unknown) => setBanksError(error instanceof Error ? error.message : String(error)));
  }, []);

  const verify = async () => {
    if (!bank) {
      setProblem("Pick your bank first.");
      return;
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      setProblem("Account numbers are exactly 10 digits.");
      return;
    }
    setBusy(true);
    setProblem(null);
    setResolvedName(null);
    try {
      const resolved = await resolvePayoutAccount(bank.code, accountNumber);
      setResolvedName(resolved.accountName);
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.status === 422
          ? "We couldn't verify this account — check the bank and the number, then try again."
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!bank || !resolvedName) return;
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await savePayoutAccount({ participantId, bankCode: bank.code, accountNumber }));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Label>Bank</Label>
      {banks === null && !banksError ? <Text style={s.muted}>Loading banks…</Text> : null}
      {banksError ? <Text style={{ color: colors.orange, fontSize: 12 }}>Bank list: {banksError}</Text> : null}
      {banks ? <Button title={bank ? bank.name : "Choose your bank"} secondary onPress={() => setPickerOpen(true)} /> : null}

      <Label>Account number · 10 digits</Label>
      <Field
        value={accountNumber}
        onChangeText={(value) => {
          setAccountNumber(value.replace(/\D/g, "").slice(0, 10));
          setResolvedName(null); // a changed number must be re-verified
        }}
        keyboardType="number-pad"
        maxLength={10}
        placeholder="0123456789"
      />

      {problem ? <Text style={{ color: colors.orange, fontSize: 12 }}>{problem}</Text> : null}

      {resolvedName && bank ? (
        <Card style={{ backgroundColor: "#EAF1E7" }}>
          <Pill active>VERIFIED</Pill>
          <Text style={{ color: colors.ink, fontWeight: "800", fontSize: 16 }}>
            Payouts go to {resolvedName} — {bank.name} {maskAccountNumber(accountNumber)}
          </Text>
          <Button title={busy ? "Saving…" : "Save payout account"} onPress={save} />
        </Card>
      ) : (
        <Button title={busy ? "Verifying…" : "Verify account"} onPress={verify} />
      )}
      {onCancel ? <Button title="Not now" secondary onPress={onCancel} /> : null}

      {/* The ui barrel has no picker — a modal list of Buttons (per doctrine). */}
      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(27,48,40,0.45)" }} onPress={() => setPickerOpen(false)} />
        <View style={{ backgroundColor: colors.paper, borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "70%", padding: 18 }}>
          <ScrollView contentContainerStyle={{ gap: 8, paddingBottom: 30 }}>
            {(banks ?? []).map((item) => (
              <Button
                key={item.code}
                title={item.name}
                secondary={bank?.code !== item.code}
                onPress={() => {
                  setBank(item);
                  setResolvedName(null);
                  setPickerOpen(false);
                }}
              />
            ))}
          </ScrollView>
        </View>
      </Modal>
    </Card>
  );
}
