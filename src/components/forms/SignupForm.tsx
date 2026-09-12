"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Alert, Button, Card, Field, Spinner, inputClass } from "@/components/ui";
import { useToast } from "@/components/Toast";
import { apiPost } from "@/lib/client";
import { formatGhs } from "@/lib/format";

export default function SignupForm() {
  const router = useRouter();
  const toast = useToast();
  const params = useSearchParams();
  const inviteFromUrl = params.get("squad") ?? params.get("invite") ?? "";
  const wantsAgent = params.get("tier") === "sub_agent";

  const [form, setForm] = useState({
    full_name: "",
    phone: "",
    pin: "",
    confirm: "",
    email: "",
    invite_code: inviteFromUrl,
    tier: wantsAgent ? "sub_agent" : ("customer" as "customer" | "sub_agent"),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!/^0?[0-9]{9,10}$/.test(form.phone.replace(/[^0-9]/g, ""))) {
      setError("Enter a valid Ghana mobile number, e.g. 0244123456.");
      return;
    }
    if (!/^[0-9]{4,6}$/.test(form.pin)) {
      setError("Choose a PIN of 4 to 6 digits.");
      return;
    }
    if (form.pin !== form.confirm) {
      setError("Those PINs do not match.");
      return;
    }

    setBusy(true);
    try {
      const result = await apiPost<{ message: string; activated: boolean }>("/api/auth/register", {
        full_name: form.full_name,
        phone: form.phone,
        pin: form.pin,
        email: form.email || null,
        invite_code: form.invite_code || null,
        tier: form.tier,
      });
      toast.success("Welcome to Priceless Bundle", result.message);
      router.push(form.tier === "sub_agent" ? "/agent" : "/buy");
      router.refresh();
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      toast.error("Could not create your account", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold">Create your account</h1>
        <p className="mt-2 text-sm text-ash-400">
          Free forever. Top up with Mobile Money and start sending data in seconds.
        </p>
      </div>

      <Card>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Full name">
            <input
              className={inputClass}
              value={form.full_name}
              onChange={(e) => update("full_name", e.target.value)}
              placeholder="Kwame Mensah"
              autoComplete="name"
              required
            />
          </Field>

          <Field label="Mobile number" hint="Ghana number you'll sign in with">
            <input
              className={inputClass}
              value={form.phone}
              onChange={(e) => update("phone", e.target.value)}
              placeholder="0244123456"
              inputMode="tel"
              autoComplete="tel"
              required
            />
          </Field>

          <Field label="Email (optional)">
            <input
              className={inputClass}
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
              placeholder="you@example.com"
              type="email"
              autoComplete="email"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Choose a PIN" hint="4–6 digits">
              <input
                className={inputClass}
                value={form.pin}
                onChange={(e) => update("pin", e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                placeholder="••••"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="Confirm PIN">
              <input
                className={inputClass}
                value={form.confirm}
                onChange={(e) => update("confirm", e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
                placeholder="••••"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                required
              />
            </Field>
          </div>

          <Field label="Account type">
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { value: "customer", title: "Customer", blurb: "Buy data for yourself" },
                  { value: "sub_agent", title: "Sub-Agent", blurb: "Resell at discount pricing" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => update("tier", option.value)}
                  className={`rounded-xl border px-3.5 py-3 text-left transition ${
                    form.tier === option.value
                      ? "border-fire-500/70 bg-fire-500/10"
                      : "border-white/10 bg-charcoal-900/60 hover:border-white/20"
                  }`}
                >
                  <p className="text-sm font-semibold text-white">{option.title}</p>
                  <p className="mt-0.5 text-[0.75rem] text-ash-400">{option.blurb}</p>
                </button>
              ))}
            </div>
          </Field>

          <Field
            label="Squad invite code (optional)"
            hint={form.invite_code ? "Joins your agent's squad" : undefined}
          >
            <input
              className={inputClass}
              value={form.invite_code}
              onChange={(e) => update("invite_code", e.target.value.toUpperCase())}
              placeholder="SQL-AB12C"
            />
          </Field>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <Button type="submit" disabled={busy} className="w-full" size="lg">
            {busy ? <Spinner /> : null}
            {busy ? "Creating account…" : "Create account"}
          </Button>

          <p className="text-center text-[0.78rem] text-ash-500">
            Super Agent unlocks automatically once you&apos;ve topped up {formatGhs(500)} in total.
          </p>
        </form>
      </Card>

      <p className="mt-5 text-center text-sm text-ash-400">
        Already registered?{" "}
        <Link href="/login" className="font-semibold text-fire-400 hover:text-fire-300">
          Sign in
        </Link>
      </p>
    </div>
  );
}
