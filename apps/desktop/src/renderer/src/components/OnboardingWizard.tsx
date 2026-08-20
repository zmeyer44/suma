import { useEffect, useRef, useState } from "react";
import {
  Check,
  Cloud,
  Fingerprint,
  KeyRound,
  Laptop,
  Link2,
  Loader2,
  Mail,
  Shield,
} from "lucide-react";
import type { EnrollmentStatus } from "../../../shared/ipc";
import { cn } from "../lib/cn";
import {
  deriveOnboardingStep,
  onboardingSteps,
  type OnboardingStep,
} from "../lib/onboarding-steps";
import { useSumaStore } from "../store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { SumaMark } from "./ui/suma-mark";

const EMAIL_RE = /^\S+@\S+\.\S+$/;

type Busy = "none" | "signup" | "device" | "passkey" | "link";

/* ── Layout pieces ──────────────────────────────────────────────────────── */

/** "STEP 2 OF 3" plus the segmented rail beside it. */
function StepRail({
  steps,
  index,
}: {
  steps: OnboardingStep[];
  index: number;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <span className="text-[10px] font-semibold tracking-[0.16em] text-faint uppercase">
        Step {index + 1} of {steps.length}
      </span>
      <span className="flex items-center gap-1.5" aria-hidden="true">
        {steps.map((name, i) => (
          <span
            key={name}
            className={cn(
              "h-[3px] rounded-full transition-all duration-200",
              i === index
                ? "w-9 bg-accent"
                : i < index
                  ? "w-6 bg-accent/45"
                  : "w-6 bg-ink/12",
            )}
          />
        ))}
      </span>
    </div>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11.5px] font-medium text-muted">
        {label}
        {optional === true ? (
          <span className="text-faint"> · optional</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

/**
 * The reference layout's pick-one tile: title row with a radio dot, then a
 * hairline-separated list of what choosing it means. Selected tiles carry the
 * accent wash; the rest sit on the same faint ink fill the empty state uses.
 */
function ChoiceCard({
  selected,
  title,
  note,
  icon,
  points,
  onSelect,
}: {
  selected: boolean;
  title: string;
  note: string;
  icon: React.ReactNode;
  points: string[];
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex cursor-pointer flex-col rounded-2xl border p-4 text-left transition-colors",
        selected
          ? "border-accent/55 bg-accent/8"
          : "border-hairline bg-ink/3 hover:border-ink/20 hover:bg-ink/6",
      )}
    >
      <span className="flex w-full items-center gap-3">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-[10px] transition-colors",
            selected ? "bg-accent/18 text-accent" : "bg-ink/6 text-muted",
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-text">
            {title}
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] text-faint">
            {note}
          </span>
        </span>
        <span
          className={cn(
            "grid size-[18px] shrink-0 place-items-center rounded-full border transition-colors",
            selected ? "border-accent bg-accent text-bg" : "border-ink/20",
          )}
        >
          {selected ? <Check className="size-2.5" /> : null}
        </span>
      </span>
      <span className="mt-3.5 flex flex-col gap-1.5 border-t border-hairline pt-3.5">
        {points.map((point) => (
          <span
            key={point}
            className="flex items-start gap-2 text-[11.5px] leading-snug text-muted"
          >
            <span
              className={cn(
                "mt-[5px] size-1 shrink-0 rounded-full",
                selected ? "bg-accent" : "bg-ink/25",
              )}
            />
            {point}
          </span>
        ))}
      </span>
    </button>
  );
}

/** One row of the provisioning checklist: done → check, active → spinner,
 *  pending → hollow dot. The detail line shows only while the row is live —
 *  finished and future stages need no explanation. */
function SetupStage({
  state,
  title,
  detail,
}: {
  state: "done" | "active" | "pending";
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={cn(
          "mt-px grid size-5 shrink-0 place-items-center rounded-full",
          state === "done"
            ? "bg-ok/15 text-ok"
            : state === "active"
              ? "bg-accent/15 text-accent"
              : "border border-ink/15",
        )}
      >
        {state === "done" ? (
          <Check className="size-3" />
        ) : state === "active" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 pt-0.5">
        <span
          className={cn(
            "block text-[13px] font-medium",
            state === "pending" ? "text-faint" : "text-text",
          )}
        >
          {title}
        </span>
        {detail !== undefined && state === "active" ? (
          <span className="mt-1 block text-[11.5px] leading-snug text-muted">
            {detail}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** The dark brand column: static across steps, like the reference's. */
function BrandRail() {
  return (
    <aside className="relative hidden w-[34%] max-w-[400px] min-w-[300px] shrink-0 flex-col overflow-hidden border-r border-hairline bg-bg md:flex">
      {/* A single accent bloom out of the top corner — the only thing keeping
          the rail from reading as a flat well next to the panel. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(110%_55%_at_0%_0%,var(--color-accent)_0%,transparent_62%)] opacity-[0.08]"
      />
      {/* h-64 w-auto, not size-64: the mark's box is wider than it is tall, and
          forcing it square would squash the globe. */}
      <SumaMark className="pointer-events-none absolute -bottom-14 -left-10 h-64 text-ink/[0.025]" />

      <div className="relative flex flex-1 flex-col px-10 pt-[54px] pb-10">
        {/* The same mark/wordmark lockup the settings rail and the marketing
            nav open with, in the user's accent. */}
        <div className="flex items-center gap-2.5">
          <SumaMark className="h-5 text-accent" />
          <span className="text-[14px] font-semibold tracking-[-0.01em] text-text">
            Suma
          </span>
        </div>

        <h2 className="mt-14 text-[26px] leading-[1.15] font-semibold tracking-[-0.02em] text-text">
          A few minutes, and this Mac holds the keys to your spaces.
        </h2>

        <ul className="mt-8 flex flex-col gap-4">
          {[
            "One account, every Mac. Enroll each one once and your spaces follow you.",
            "Your spaces are end-to-end encrypted — Suma's servers never see your keys.",
            "A recovery code at the end is the only way back if every Mac is lost.",
          ].map((line) => (
            <li key={line} className="flex items-start gap-2.5">
              <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-ok/15 text-ok">
                <Check className="size-2.5" />
              </span>
              <span className="text-[12.5px] leading-relaxed text-muted">
                {line}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-auto flex items-start gap-2.5 rounded-xl border border-hairline bg-ink/4 px-3.5 py-3">
          <Shield className="mt-px size-3.5 shrink-0 text-faint" />
          <p className="text-[11px] leading-relaxed text-faint">
            The credential you register stays in this Mac&apos;s secure storage.
            Nothing here leaves the machine except an encrypted enrollment
            record.
          </p>
        </div>
      </div>
    </aside>
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** WebAuthn responses carry ArrayBuffers — serialize before crossing IPC. */
function credentialToJson(credential: Credential): unknown {
  const c = credential as Credential & { toJSON?: () => unknown };
  return typeof c.toJSON === "function" ? c.toJSON() : credential;
}

/**
 * First-run enrollment flow (§8.2): account → device credential (device key
 * by default, passkey opt-in — the ONLY place WebAuthn runs) → shown-once
 * recovery code. Dismissible until enrollment; progress persists via auth
 * status, so a restart resumes at the right step.
 *
 * Drawn as a full-window screen rather than a modal: this is the first thing a
 * new install shows, there is nothing behind it worth peeking at, and the
 * branching (create vs link, device key vs passkey) needs room to be picked
 * from rather than buried in a stack of buttons. It sits at z-50 over the whole
 * chrome page — the tab strip included — and keeps a drag strip along the top
 * so the window can still be moved. `wizardOpen` is what tells main to raise
 * the chrome view above the tab WebContentsViews (App.tsx), so the screen is
 * actually visible when a tab is already open.
 */
export function OnboardingWizard() {
  const auth = useSumaStore((s) => s.auth);
  const authKnown = useSumaStore((s) => s.authKnown);
  const dismissed = useSumaStore((s) => s.onboardingDismissed);
  const dismissOnboarding = useSumaStore((s) => s.dismissOnboarding);
  const signup = useSumaStore((s) => s.signup);
  const signinWithCode = useSumaStore((s) => s.signinWithCode);
  const enrollDevice = useSumaStore((s) => s.enrollDevice);
  const registerDeviceCredential = useSumaStore(
    (s) => s.registerDeviceCredential,
  );
  const passkeyBegin = useSumaStore((s) => s.passkeyBegin);
  const passkeyFinish = useSumaStore((s) => s.passkeyFinish);
  const pushToast = useSumaStore((s) => s.pushToast);
  const machine = useSumaStore((s) => s.machine);
  const workspaceSource = useSumaStore((s) => s.workspaceSource);
  const workspaceConnected = useSumaStore((s) => s.workspaceConnected);
  const refreshMachine = useSumaStore((s) => s.refreshMachine);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  /** "create" = new account; "link" = enrollment code from another Mac (§8.2). */
  const [accountMode, setAccountMode] = useState<"create" | "link">("create");
  const [linkCode, setLinkCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  /** Where the account's computer lives — rides the signup POST, so the
   *  computer step must precede it. Cloud is the recommended default. */
  const [computeChoice, setComputeChoice] = useState<"cloud" | "local">(
    "cloud",
  );
  /** The account form validated and the user continued to the computer step.
   *  Component-local on purpose: a restart before signup resumes at account. */
  const [accountConfirmed, setAccountConfirmed] = useState(false);
  /** Which credential the step-2 tiles have selected; the device key is the
   *  default path, passkey is opt-in. */
  const [credentialChoice, setCredentialChoice] = useState<
    "device" | "passkey"
  >("device");
  const [busy, setBusy] = useState<Busy>("none");
  const [notice, setNotice] = useState<string | null>(null);
  /** Provisioning has run long enough that silence would read as a hang. */
  const [waitedLong, setWaitedLong] = useState(false);
  /** Held ONLY here, shown once, cleared on finish — never enters the store. */
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  const credentialDone = auth.state === "enrolled" && auth.passkeyRegistered;
  const localOnly = auth.controlUrl === null;
  /** The control plane says the VM exists and is awake — narrative only. */
  const machineUp =
    machine !== null &&
    machine.machineId !== null &&
    machine.state === "running";
  const machineErrored =
    machine !== null && machine.machineId !== null && machine.state === "error";
  /** The bar for moving on is the thing that actually failed in production:
   *  this Mac's agent link reaching the machine. Deliberately NOT gated on
   *  machine.state — the row can lag the real VM (no client path moves
   *  provisioning → running), and a connected agent is proof enough. */
  const machineReady =
    workspaceSource === "remote" && workspaceConnected === true;
  /** The provisioning story's midpoint: the machine exists (control reports
   *  it awake, or its address already retargeted the link) — now dialing. */
  const machineDialing = machineUp || workspaceSource === "remote";
  const step = deriveOnboardingStep({
    authState: auth.state,
    credentialDone,
    recoveryCodeShowing: recoveryCode !== null,
    accountConfirmed,
    localOnly,
    accountMode,
    computeMode: auth.computeMode,
    machineReady,
  });
  const steps = onboardingSteps({ localOnly, accountMode });

  // Only this component knows its full visibility (the recovery step depends
  // on component-local state); App raises the chrome view off this flag.
  const visible = authKnown && !dismissed && step !== null;
  // A signed-up device must consume its short-lived bootstrap credential now;
  // once a recovery code exists it likewise MUST be shown and saved.
  const canDismiss =
    !(step === "credential" && auth.state === "signed-up") &&
    step !== "recovery" &&
    recoveryCode === null;

  const setWizardOpen = useSumaStore((s) => s.setWizardOpen);
  useEffect(() => {
    setWizardOpen(visible);
    return () => setWizardOpen(false);
  }, [visible, setWizardOpen]);

  // Escape still dismisses, the way it did while this was a dialog.
  useEffect(() => {
    if (!visible || !canDismiss) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissOnboarding();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [visible, canDismiss, dismissOnboarding]);

  // Provisioning holds until the VM answers, and main's 15-second machine
  // poll is too coarse to watch a boot — so poll the live control-plane
  // status directly while this step is showing. Each refresh that reports
  // the machine awake also re-arms the agent link's reconnect (machine
  // service → link.retryNow), so the connection follows the boot within a
  // poll instead of a backoff. The step advances by derivation: the moment
  // machineReady flips true, `step` recomputes to "recovery".
  useEffect(() => {
    if (step !== "provisioning") return;
    void refreshMachine();
    const poll = setInterval(() => void refreshMachine(), 2_000);
    const slow = setTimeout(() => setWaitedLong(true), 90_000);
    return () => {
      clearInterval(poll);
      clearTimeout(slow);
      setWaitedLong(false);
    };
  }, [step, refreshMachine]);

  // One field is the obvious target on every step that has one, and only one
  // of them is mounted at a time — so a single ref covers all of them.
  const firstFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [step, accountMode]);

  if (!visible || step === null) return null;

  // Provisioning runs after this Mac is secured and before its recovery code
  // is revealed, so it shares the credential rail segment.
  const stepIndex = steps.indexOf(
    step === "provisioning" ? "credential" : step,
  );

  const captureRecovery = (status: EnrollmentStatus | undefined) => {
    const code = status?.recoveryCode;
    if (code !== undefined && code.length > 0) {
      setRecoveryCode((prev) => prev ?? code);
    }
  };

  /**
   * Continue off the account form. Against a control plane this only
   * validates and advances to the computer step — the signup POST needs the
   * compute choice. Local-only keeps signing up right here (there is no
   * computer to choose).
   */
  const submitAccount = async () => {
    const addr = email.trim();
    if (!EMAIL_RE.test(addr) || busy !== "none") return;
    if (!localOnly) {
      setNotice(null);
      setAccountConfirmed(true);
      return;
    }
    setBusy("signup");
    const status = await signup(
      addr,
      displayName.trim() || undefined,
      inviteCode.trim() || undefined,
    );
    captureRecovery(status);
    setBusy("none");
  };

  /** The computer step's primary: create the account with the chosen mode. */
  const submitComputer = async () => {
    const addr = email.trim();
    if (!EMAIL_RE.test(addr) || busy !== "none") return;
    setBusy("signup");
    setNotice(null);
    const status = await signup(
      addr,
      displayName.trim() || undefined,
      inviteCode.trim() || undefined,
      computeChoice,
    );
    if (status === undefined) {
      setNotice(
        "Couldn't create the account — check the invite code and try again.",
      );
    }
    captureRecovery(status);
    setBusy("none");
  };

  const submitLink = async () => {
    const code = linkCode.trim();
    if (code.length === 0 || busy !== "none") return;
    setBusy("link");
    const status = await signinWithCode(code);
    if (status === undefined) {
      setNotice(
        "That code didn't work — codes are single-use and expire after 10 minutes.",
      );
    }
    setBusy("none");
  };

  /** Step 2 starts with device enrollment, whichever credential path is taken. */
  const ensureEnrolled = async (): Promise<EnrollmentStatus | null> => {
    if (auth.state !== "signed-up") return auth;
    const status = await enrollDevice(
      deviceName.trim() || auth.deviceName || auth.suggestedDeviceName,
    );
    if (status === undefined) return null;
    captureRecovery(status);
    return status;
  };

  const registerWithDeviceKey = async () => {
    if (busy !== "none") return;
    setBusy("device");
    setNotice(null);
    const enrolled = await ensureEnrolled();
    if (enrolled !== null) {
      const status = await registerDeviceCredential();
      captureRecovery(status);
    }
    setBusy("none");
  };

  const registerWithPasskey = async () => {
    if (busy !== "none") return;
    setBusy("passkey");
    setNotice(null);
    const enrolled = await ensureEnrolled();
    if (enrolled === null) {
      setBusy("none");
      return;
    }
    try {
      if (typeof navigator.credentials?.create !== "function") {
        throw new Error("WebAuthn is not available in this build");
      }
      const begin = await passkeyBegin();
      if (begin === undefined)
        throw new Error("could not start passkey registration");
      // The ONLY place WebAuthn runs — everything else goes through window.suma.
      const credential = await navigator.credentials.create(
        begin.options as CredentialCreationOptions,
      );
      if (credential === null) throw new Error("no credential returned");
      const status = await passkeyFinish(credentialToJson(credential));
      if (status === undefined)
        throw new Error("the control plane rejected the passkey");
      captureRecovery(status);
    } catch (err) {
      setNotice(
        `Passkey didn't work (${errorMessage(err)}) — using this Mac's device key instead.`,
      );
      const status = await registerDeviceCredential();
      captureRecovery(status);
    }
    setBusy("none");
  };

  const copyCode = async () => {
    if (recoveryCode === null) return;
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      pushToast(
        "Couldn't copy — select the code and copy it manually",
        "error",
      );
    }
  };

  const finish = () => {
    if (!savedConfirmed) return;
    setRecoveryCode(null);
    setSavedConfirmed(false);
    dismissOnboarding();
    pushToast("Setup complete — this Mac now holds your space keys", "success");
  };

  const headline =
    step === "account"
      ? // Local-only has no second path to offer, so it asks nothing.
        localOnly
        ? "Create your account"
        : "How do you want to start?"
      : step === "computer"
        ? "Where should your computer live?"
        : step === "provisioning"
          ? "Setting up your computer"
          : step === "credential"
            ? "What should unlock this Mac?"
            : "Save your recovery code";

  const blurb =
    step === "account"
      ? "One account, every Mac. Your spaces are end-to-end encrypted — Suma's servers never see your keys."
      : step === "computer"
        ? "Every device you enroll sees the same files, downloads, and terminal — this is where they actually live."
        : step === "provisioning"
          ? "Your account is in. Suma is now building your private Linux machine — the computer your files, downloads, and terminal will live on. This usually takes under a minute."
          : step === "credential"
            ? "This credential wraps the keys that unlock your spaces. It is registered on this Mac only; other Macs enroll with their own."
            : "If you lose every enrolled Mac, this code is the only way back into your encrypted spaces. Suma cannot show it again.";

  /** The one primary action, per step — the footer button and Enter both run it. */
  const primary: { label: string; disabled: boolean; run: () => void } =
    step === "account"
      ? accountMode === "create"
        ? {
            label: busy === "signup" ? "Creating account…" : "Continue",
            disabled: !EMAIL_RE.test(email.trim()) || busy !== "none",
            run: () => void submitAccount(),
          }
        : {
            label: busy === "link" ? "Linking…" : "Link this Mac",
            disabled: linkCode.trim().length === 0 || busy !== "none",
            run: () => void submitLink(),
          }
      : step === "computer"
        ? {
            label:
              busy === "signup"
                ? "Setting up your computer…"
                : "Create my computer",
            disabled: busy !== "none",
            run: () => void submitComputer(),
          }
        : step === "provisioning"
          ? {
              // Never enabled: this step advances itself the moment the
              // machine is reachable. The label narrates the wait instead.
              label: machineErrored
                ? "Waiting on the machine…"
                : machineDialing
                  ? "Connecting…"
                  : "Creating your machine…",
              disabled: true,
              run: () => {},
            }
          : step === "credential"
            ? {
                label:
                  busy === "device"
                    ? "Registering…"
                    : busy === "passkey"
                      ? "Waiting for your passkey…"
                      : "Secure this Mac",
                disabled: busy !== "none",
                run: () =>
                  void (credentialChoice === "passkey"
                    ? registerWithPasskey()
                    : registerWithDeviceKey()),
              }
            : { label: "Finish setup", disabled: !savedConfirmed, run: finish };

  return (
    /* z-40, the overlay layer — NOT above it. The screen lives in #root while
       every modal portals to <body>, so at equal z-index a later-mounted
       portal (the passkey ceremony, which App keeps above everything) still
       paints on top. The toast stack sits above it either way. */
    <div className="fixed inset-0 z-40 flex bg-panel text-text">
      <BrandRail />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!primary.disabled) primary.run();
        }}
        className="flex min-w-0 flex-1 justify-center overflow-y-auto"
      >
        <div className="flex w-full max-w-[620px] flex-col px-10 pt-[54px] pb-10">
          <StepRail steps={steps} index={stepIndex} />

          <h1 className="mt-7 text-[27px] leading-[1.15] font-semibold tracking-[-0.02em] text-text">
            {headline}
          </h1>
          <p className="mt-3 max-w-[52ch] text-[13px] leading-relaxed text-muted">
            {blurb}
          </p>

          {notice !== null ? (
            <p className="mt-5 rounded-xl bg-warn/10 px-3.5 py-2.5 text-[12px] leading-snug text-warn">
              {notice}
            </p>
          ) : null}

          {step === "account" ? (
            <>
              {/* Linking needs a control plane, so local-only has nothing to
                  choose between — it drops straight to the form. */}
              {!localOnly ? (
                <div className="mt-7 grid grid-cols-2 gap-3">
                  <ChoiceCard
                    selected={accountMode === "create"}
                    onSelect={() => setAccountMode("create")}
                    title="Create an account"
                    note="New to Suma"
                    icon={<Mail className="size-3.5" />}
                    points={[
                      "Takes about a minute",
                      "The beta is invitation-only",
                    ]}
                  />
                  <ChoiceCard
                    selected={accountMode === "link"}
                    onSelect={() => setAccountMode("link")}
                    title="Link this Mac"
                    note="Already using Suma"
                    icon={<Link2 className="size-3.5" />}
                    points={[
                      "Uses a code from your other Mac",
                      "Codes are single-use and expire in 10 minutes",
                    ]}
                  />
                </div>
              ) : null}

              {accountMode === "create" ? (
                <div className="mt-6 flex flex-col gap-4">
                  {localOnly ? (
                    <p className="rounded-xl bg-ink/4 px-3.5 py-2.5 text-[12px] leading-snug text-muted">
                      Running locally — sync is on this Mac only. You can finish
                      setup now and Suma will connect when a control plane is
                      configured.
                    </p>
                  ) : null}
                  <Field label="Email">
                    <Input
                      size="xl"
                      ref={firstFieldRef}
                      type="email"
                      value={email}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="you@example.com"
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full"
                    />
                  </Field>
                  <div
                    className={cn(
                      "grid gap-4",
                      localOnly ? "grid-cols-1" : "grid-cols-2",
                    )}
                  >
                    <Field label="Display name" optional>
                      <Input
                        size="xl"
                        type="text"
                        value={displayName}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="How your devices greet you"
                        onChange={(e) => setDisplayName(e.target.value)}
                        className="w-full"
                      />
                    </Field>
                    {!localOnly ? (
                      <Field label="Invite code" optional>
                        <Input
                          size="xl"
                          type="text"
                          value={inviteCode}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder="sm-inv-…"
                          onChange={(e) => setInviteCode(e.target.value)}
                          className="w-full"
                        />
                      </Field>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="mt-6 flex flex-col gap-4">
                  <p className="text-[12.5px] leading-relaxed text-muted">
                    On your other Mac, open Settings → Devices and choose{" "}
                    <span className="text-text">Link another device</span>.
                    Enter the code it shows you.
                  </p>
                  <Field label="Enrollment code">
                    <Input
                      size="xl"
                      ref={firstFieldRef}
                      type="text"
                      value={linkCode}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="Code from your other Mac"
                      onChange={(e) => setLinkCode(e.target.value)}
                      className="w-full"
                    />
                  </Field>
                </div>
              )}
            </>
          ) : null}

          {step === "computer" ? (
            <div className="mt-7 grid grid-cols-2 gap-3">
              <ChoiceCard
                selected={computeChoice === "cloud"}
                onSelect={() => setComputeChoice("cloud")}
                title="Cloud computer"
                note="Recommended"
                icon={<Cloud className="size-3.5" />}
                points={[
                  "A private Linux machine, reachable from every Mac",
                  "Files and downloads follow you everywhere",
                  "Suspends when idle — no cost while asleep",
                ]}
              />
              <ChoiceCard
                selected={computeChoice === "local"}
                onSelect={() => setComputeChoice("local")}
                title="This Mac"
                note="Keep everything here"
                icon={<Laptop className="size-3.5" />}
                points={[
                  "Your files live in a Suma folder on this Mac",
                  "No cloud machine is created",
                  "Access from other devices comes later",
                ]}
              />
            </div>
          ) : null}

          {step === "provisioning" ? (
            <div className="mt-7 flex flex-col gap-4">
              {machineErrored ? (
                <p className="rounded-xl bg-warn/10 px-3.5 py-2.5 text-[12px] leading-snug text-warn">
                  The machine hit an error while starting — Suma keeps retrying
                  automatically. If this doesn&apos;t clear in a few minutes,
                  choose &ldquo;I&apos;ll do this later&rdquo; and your computer
                  will finish setting up in the background.
                </p>
              ) : null}

              <div className="flex flex-col gap-4 rounded-2xl border border-hairline bg-ink/3 px-5 py-5">
                <SetupStage state="done" title="Account created" />
                <SetupStage
                  state={
                    machineDialing
                      ? "done"
                      : machineErrored
                        ? "pending"
                        : "active"
                  }
                  title="Creating your Linux machine"
                  detail="A private cloud computer, reachable from every Mac you enroll. It suspends when idle, so it costs nothing while you're away."
                />
                <SetupStage
                  state={machineDialing ? "active" : "pending"}
                  title="Connecting this Mac to it"
                  detail="The machine is up — opening the link your files and terminal travel over."
                />
              </div>

              {waitedLong && !machineErrored ? (
                <p className="text-[11.5px] leading-snug text-faint">
                  Still working — cloud machines occasionally take a few minutes
                  on their first boot. You can leave this window open; setup
                  continues on its own.
                </p>
              ) : null}
            </div>
          ) : null}

          {step === "credential" ? (
            <>
              {auth.email !== null ? (
                <p className="mt-4 inline-flex w-fit items-center gap-2 rounded-full border border-hairline bg-ink/4 px-3 py-1 text-[11.5px] text-muted">
                  <span className="size-1.5 rounded-full bg-ok" />
                  Signed up as <span className="text-text">{auth.email}</span>
                </p>
              ) : null}

              <div className="mt-7 grid grid-cols-2 gap-3">
                <ChoiceCard
                  selected={credentialChoice === "device"}
                  onSelect={() => setCredentialChoice("device")}
                  title="This Mac's device key"
                  note="Recommended"
                  icon={<KeyRound className="size-3.5" />}
                  points={[
                    "Lives in this Mac's secure storage",
                    "Nothing to set up — it never leaves the machine",
                  ]}
                />
                <ChoiceCard
                  selected={credentialChoice === "passkey"}
                  onSelect={() => setCredentialChoice("passkey")}
                  title="A passkey"
                  note="Touch ID or a security key"
                  icon={<Fingerprint className="size-3.5" />}
                  points={[
                    "Your authenticator holds the credential",
                    "Falls back to the device key if it doesn't work",
                  ]}
                />
              </div>

              <div className="mt-6 max-w-[320px]">
                <Field label="Device name">
                  <Input
                    size="xl"
                    ref={firstFieldRef}
                    type="text"
                    value={deviceName}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={auth.deviceName ?? auth.suggestedDeviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                    className="w-full"
                  />
                </Field>
              </div>
            </>
          ) : null}

          {step === "recovery" && recoveryCode !== null ? (
            <div className="mt-7 flex flex-col gap-4">
              <div className="rounded-2xl border border-accent/30 bg-accent/6 px-6 py-6 text-center">
                {/* overflow-wrap:anywhere, not break-all: the code's own
                    hyphens are wrap opportunities, so a code too wide for the
                    panel splits between groups instead of mid-group. */}
                <p className="font-mono text-[19px] leading-relaxed font-semibold tracking-[0.08em] [overflow-wrap:anywhere] text-text select-text">
                  {recoveryCode}
                </p>
                <Button
                  variant="secondary"
                  size="lg"
                  className="mt-4"
                  onClick={() => void copyCode()}
                >
                  {copied ? "Copied" : "Copy code"}
                </Button>
              </div>
              <label className="flex w-fit cursor-pointer items-center gap-2.5 text-[13px] text-text">
                <Checkbox
                  checked={savedConfirmed}
                  onCheckedChange={setSavedConfirmed}
                />
                I&apos;ve saved this code somewhere safe
              </label>
            </div>
          ) : null}

          {/* Footer: pinned to the bottom of the column when the content is
              short, pushed down by it when it isn't. */}
          <div className="mt-auto flex items-center gap-3 pt-10">
            {step === "account" && accountMode === "link" ? (
              <Button
                variant="ghost"
                size="xl"
                onClick={() => setAccountMode("create")}
              >
                Back
              </Button>
            ) : null}
            {step === "computer" ? (
              <Button
                variant="ghost"
                size="xl"
                onClick={() => {
                  setAccountConfirmed(false);
                  setNotice(null);
                }}
              >
                Back
              </Button>
            ) : null}
            <span className="flex-1" />
            {canDismiss ? (
              <Button variant="ghost" size="xl" onClick={dismissOnboarding}>
                {step === "account"
                  ? "Skip — local only"
                  : "I'll do this later"}
              </Button>
            ) : null}
            <Button type="submit" size="xl" disabled={primary.disabled}>
              {primary.label}
            </Button>
          </div>
        </div>
      </form>

      {/* The screen covers the titlebar, so it has to hand the drag back.
          Last child, no fill: the columns paint over everything below it. */}
      <div
        className="drag-region absolute inset-x-0 top-0 h-11"
        aria-hidden="true"
      />
    </div>
  );
}
