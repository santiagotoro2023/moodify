import { useCallback, useEffect, useState } from 'react';
import { MAIL_FONTS, TEMPLATE_FIELDS, type NotificationRuleDto, type SmtpState } from '@moodify/shared';
import { Mail, Plus, Trash2 } from 'lucide-react';
import { api, cn, errorMessage, relativeTime } from '@/lib/api';
import { Button, Card, ErrorNote, Input, Label, Select, Spinner, Switch } from '@/ui';

/**
 * Email reminders: where to send from, and the global rules for when.
 *
 * Rules apply to every task rather than being attached to one, so "five days before" is
 * configured once instead of twenty times. Several lead-time rules can coexist (14 days,
 * 5 days, 1 day); the overdue rule fires once, when the date passes.
 *
 * The SMTP password is write-only here, exactly like the Moodle token: it can be
 * replaced, never read back.
 */

const BLANK_RULE = {
  kind: 'before' as const,
  daysBefore: 5,
  subject: 'Reminder: {activity} is due on {due}',
  body: 'Hi {name},\n\nThis is due on {due}, in {days} day(s):\n\n{activity}\n\n— Moodify',
  enabled: true,
};

function RuleEditor({
  rule,
  onSave,
  onDelete,
  onCancel,
}: {
  rule: NotificationRuleDto | typeof BLANK_RULE;
  onSave: (rule: Omit<NotificationRuleDto, 'id'>) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [kind, setKind] = useState(rule.kind);
  const [days, setDays] = useState(String(rule.daysBefore ?? 5));
  const [subject, setSubject] = useState(rule.subject);
  const [body, setBody] = useState(rule.body);
  const [enabled, setEnabled] = useState(rule.enabled);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await onSave({
        kind,
        daysBefore: kind === 'before' ? Number(days) : null,
        subject,
        body,
        enabled,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-edge p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label>When</Label>
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'before' | 'overdue')}>
            <option value="before">Before the due date</option>
            <option value="overdue">When it becomes overdue</option>
          </Select>
        </div>
        {kind === 'before' ? (
          <div>
            <Label>Days ahead</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
          </div>
        ) : null}
      </div>

      <div>
        <Label>Subject</Label>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div>
        <Label>Message</Label>
        <textarea
          value={body}
          rows={7}
          onChange={(e) => setBody(e.target.value)}
          className="w-full rounded-xl border border-edge bg-ground-soft px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
        <p className="mt-1 text-xs text-muted">
          Placeholders: {TEMPLATE_FIELDS.map((field) => `{${field}}`).join(', ')}. When one
          message covers several activities, <code>{'{activity}'}</code> becomes a list and
          the subject says how many; each entry links to the activity in Moodle. HTML is
          allowed here and the subject is stripped back to text.
        </p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label className="mb-0">Rule active</Label>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Spinner className="h-4 w-4" /> : null}
          Save rule
        </Button>
        {onCancel ? (
          <Button variant="subtle" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {onDelete ? (
          <Button variant="ghost" size="icon" aria-label="Delete rule" onClick={() => void onDelete()}>
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

/**
 * Microsoft 365 sign-in, in three fields and one code.
 *
 * The admin registers an app in their own directory and pastes its two ids — neither is
 * a secret; a public client id is meant to be seen. Signing in then happens on
 * Microsoft's own page, so no password ever passes through Moodify, and what comes back
 * can do exactly one thing: send mail as the person who signed in. Nothing here needs a
 * tenant-wide setting changed, which is the whole reason this exists beside SMTP.
 */
function GraphConnection({
  smtp,
  device,
  busy,
  onField,
  onDevice,
  onError,
  onDisconnected,
}: {
  smtp: SmtpState;
  device: DeviceCode | null;
  busy: boolean;
  onField: (key: keyof SmtpState, value: string) => void;
  onDevice: (device: DeviceCode | null) => void;
  onError: (message: string) => void;
  onDisconnected: () => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    try {
      onDevice(
        await api.post<DeviceCode>('/api/notifications/graph/start', {
          tenantId: smtp.graphTenantId,
          clientId: smtp.graphClientId,
        }),
      );
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  if (device !== null) {
    return (
      <div className="space-y-2 rounded-xl border border-edge bg-ground-soft px-3 py-3 text-sm">
        <p>
          Open{' '}
          <a
            href={device.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {device.verificationUri}
          </a>{' '}
          and enter this code:
        </p>
        <p className="text-2xl font-semibold tracking-[0.2em] tabular-nums">{device.userCode}</p>
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3.5 w-3.5" />
          Waiting for you to finish signing in. Sign in with the mailbox the reminders
          should come from.
        </p>
        <Button variant="subtle" size="sm" onClick={() => onDevice(null)}>
          Cancel
        </Button>
      </div>
    );
  }

  if (smtp.graphAccount !== null) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-ground-soft px-3 py-2">
        <p className="text-sm">
          Sending as <span className="font-medium">{smtp.graphAccount}</span>
          <span className="mt-0.5 block text-xs text-muted">
            Mail goes out as this mailbox. The from-name and from-address above are not
            used — a delegated sign-in cannot send as anyone else.
          </span>
        </p>
        <Button
          variant="subtle"
          size="sm"
          onClick={() =>
            void api
              .post('/api/notifications/graph/disconnect')
              .then(onDisconnected)
              .catch((err: unknown) => onError(errorMessage(err)))
          }
        >
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="graph-tenant">Directory (tenant) ID</Label>
          <Input
            id="graph-tenant"
            value={smtp.graphTenantId}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => onField('graphTenantId', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="graph-client">Application (client) ID</Label>
          <Input
            id="graph-client"
            value={smtp.graphClientId}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => onField('graphClientId', e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted">
        Both come from your app registration in Microsoft Entra: a single-tenant app with
        public client flows allowed and the delegated Graph permissions{' '}
        <code>Mail.Send</code>, <code>User.Read</code> and <code>offline_access</code>. No
        redirect URI and no client secret are needed.
      </p>
      <Button
        onClick={() => void start()}
        disabled={busy || starting || smtp.graphTenantId.trim() === '' || smtp.graphClientId.trim() === ''}
      >
        {starting ? <Spinner className="h-4 w-4" /> : null}
        Connect mailbox
      </Button>
    </div>
  );
}

export function NotificationsCard() {
  const [smtp, setSmtp] = useState<SmtpState | null>(null);
  const [rules, setRules] = useState<NotificationRuleDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [testTo, setTestTo] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set while a Microsoft sign-in is waiting on the human at microsoft.com/devicelogin. */
  const [device, setDevice] = useState<DeviceCode | null>(null);

  const load = useCallback(async () => {
    try {
      const [state, list] = await Promise.all([
        api.get<SmtpState>('/api/notifications/smtp'),
        api.get<NotificationRuleDto[]>('/api/notifications/rules'),
      ]);
      setSmtp(state);
      setRules(list);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Microsoft's own interval, honoured because polling faster earns a slow_down and then
  // a hard refusal. The code expires by itself, at which point the poll returns the
  // reason and this stops.
  useEffect(() => {
    if (device === null) return;
    const timer = setInterval(() => {
      void api
        .post<{ pending: boolean; account: string | null }>('/api/notifications/graph/poll', {
          deviceCode: device.deviceCode,
        })
        .then(async (result) => {
          if (result.pending) return;
          setDevice(null);
          await load();
          setNote(`Connected as ${result.account ?? 'the signed-in mailbox'}.`);
        })
        .catch((err: unknown) => {
          setDevice(null);
          setError(errorMessage(err));
        });
    }, Math.max(3, device.interval) * 1000);
    return () => clearInterval(timer);
  }, [device, load]);

  if (smtp === null) {
    return (
      <Card>
        {error ? <ErrorNote message={error} /> : <Spinner className="h-6 w-6" />}
      </Card>
    );
  }

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      await api.patch('/api/notifications/smtp', body);
      setPassword('');
      await load();
      setNote('Saved.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof SmtpState, value: string | number | boolean) =>
    setSmtp({ ...smtp, [key]: value } as SmtpState);

  return (
    <Card className="space-y-4">
      <h2 className="flex items-center gap-2 font-medium">
        <Mail className="h-4 w-4 text-muted" />
        Email reminders
      </h2>
      <p className="text-xs text-muted">
        Addresses come from Moodle. Nothing is ever sent while the switch below is off, and
        rules apply to every task on the Tasks page.
      </p>

      <div className="flex items-center justify-between gap-4">
        <Label className="mb-0">
          Send reminders
          {smtp.lastSentAt ? (
            <span className="mt-0.5 block text-xs font-normal text-muted">
              Last message {relativeTime(smtp.lastSentAt)}
            </span>
          ) : null}
        </Label>
        <Switch checked={smtp.enabled} onCheckedChange={(v) => void patch({ enabled: v })} />
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Label htmlFor="smtp-send-hour" className="mb-0 self-center">
          Send the day's reminders at
          <span className="mt-0.5 block text-xs font-normal text-muted">
            Everything owed that day goes out in one batch at this hour, rather than
            whenever the fifteen-minute pass happens to notice it. Sending by hand from
            the Tasks page ignores this.
          </span>
        </Label>
        <Select
          id="smtp-send-hour"
          className="self-center"
          value={String(smtp.sendHour)}
          onChange={(e) => void patch({ sendHour: Number(e.target.value) })}
        >
          {Array.from({ length: 24 }, (_, hour) => (
            <option key={hour} value={hour}>
              {`${hour}`.padStart(2, '0')}:00
            </option>
          ))}
        </Select>
      </div>

      {smtp.lastError ? (
        <p className="rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">
          Last send failed: {smtp.lastError}
        </p>
      ) : null}

      <div>
        <Label htmlFor="mail-transport">Send through</Label>
        <Select
          id="mail-transport"
          value={smtp.transport}
          onChange={(e) => void patch({ transport: e.target.value })}
        >
          <option value="smtp">An SMTP server</option>
          <option value="graph">Microsoft 365 (my mailbox)</option>
        </Select>
      </div>

      {smtp.transport === 'graph' ? (
        <GraphConnection
          smtp={smtp}
          device={device}
          busy={busy}
          onField={field}
          onDevice={setDevice}
          onError={setError}
          onDisconnected={load}
        />
      ) : (
      <>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="smtp-host">SMTP host</Label>
          <Input
            id="smtp-host"
            value={smtp.host}
            placeholder="smtp.example.ch"
            onChange={(e) => field('host', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="smtp-port">Port</Label>
          <Input
            id="smtp-port"
            type="number"
            value={String(smtp.port)}
            onChange={(e) => field('port', Number(e.target.value))}
          />
        </div>
        <div>
          <Label htmlFor="smtp-user">Username</Label>
          <Input
            id="smtp-user"
            value={smtp.username}
            onChange={(e) => field('username', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="smtp-pass">Password</Label>
          <Input
            id="smtp-pass"
            type="password"
            value={password}
            placeholder={smtp.passwordSet ? '•••••••• (stored)' : 'none set'}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="smtp-from-name">From name</Label>
          <Input
            id="smtp-from-name"
            value={smtp.fromName}
            onChange={(e) => field('fromName', e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="smtp-from">From address</Label>
          <Input
            id="smtp-from"
            value={smtp.fromEmail}
            placeholder="moodify@example.ch"
            onChange={(e) => field('fromEmail', e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <Label className="mb-0">
          Implicit TLS
          <span className="mt-0.5 block text-xs font-normal text-muted">
            On for port 465. Leave off for 587, which upgrades with STARTTLS.
          </span>
        </Label>
        <Switch checked={smtp.secure} onCheckedChange={(v) => field('secure', v)} />
      </div>

      <Button
        onClick={() =>
          void patch({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            username: smtp.username,
            fromName: smtp.fromName,
            fromEmail: smtp.fromEmail,
            ...(password === '' ? {} : { password }),
          })
        }
        disabled={busy}
      >
        {busy ? <Spinner className="h-4 w-4" /> : null}
        Save server settings
      </Button>
      </>
      )}

      <div className="border-t border-edge pt-4">
        <Label htmlFor="smtp-test">Send a test message</Label>
        <div className="flex gap-2">
          <Input
            id="smtp-test"
            value={testTo}
            placeholder="you@example.ch"
            onChange={(e) => setTestTo(e.target.value)}
          />
          <Button
            variant="subtle"
            onClick={async () => {
              setNote(null);
              try {
                await api.post('/api/notifications/test', { to: testTo });
                setNote(`Test message sent to ${testTo}.`);
                setError(null);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            Send
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted">
          Works regardless of the switch above, so the server can be proven before anyone
          else gets mail.
        </p>
      </div>

      <div className="space-y-3 border-t border-edge pt-4">
        <h3 className="text-sm font-medium">How the messages look</h3>
        <p className="text-xs text-muted">
          Applies to every reminder. A rule's own text may contain HTML — <code>&lt;b&gt;</code>,{' '}
          <code>&lt;span style="color:#c00"&gt;</code>, <code>&lt;img src="https://…"&gt;</code> —
          for anything these four do not cover. A plain-text copy is sent alongside for clients
          that will not show HTML, so nothing depends on the markup arriving.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="mail-font">Font</Label>
            <Select
              id="mail-font"
              value={smtp.mailFont}
              onChange={(e) => void patch({ mailFont: e.target.value })}
            >
              {MAIL_FONTS.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="mail-size">Text size</Label>
            <Select
              id="mail-size"
              value={String(smtp.mailFontSize)}
              onChange={(e) => void patch({ mailFontSize: Number(e.target.value) })}
            >
              {Array.from({ length: 19 }, (_, index) => index + 10).map((size) => (
                <option key={size} value={size}>
                  {size}px
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="mail-color">Text colour</Label>
            <Input
              id="mail-color"
              type="color"
              className="h-10 p-1"
              value={smtp.mailTextColor}
              onChange={(e) => void patch({ mailTextColor: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="mail-accent">Link colour</Label>
            <Input
              id="mail-accent"
              type="color"
              className="h-10 p-1"
              value={smtp.mailAccentColor}
              onChange={(e) => void patch({ mailAccentColor: e.target.value })}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label className="mb-0">
            Logo at the top
            <span className="mt-0.5 block text-xs font-normal text-muted">
              Uses the logo from Settings. Needs the public address set under Sharing —
              a mail client cannot fetch a relative image, and shows a broken box instead.
            </span>
          </Label>
          <Switch
            checked={smtp.mailShowLogo}
            onCheckedChange={(v) => void patch({ mailShowLogo: v })}
          />
        </div>
      </div>

      <div className="space-y-3 border-t border-edge pt-4">
        <div className="flex items-center justify-between gap-4">
          <Label className="mb-0">
            Daily report to you
            <span className="mt-0.5 block text-xs font-normal text-muted">
              One message a day listing everything overdue and everything due within a week,
              instead of watching the board.
            </span>
          </Label>
          <Switch
            checked={smtp.dailyReport}
            onCheckedChange={(v) => void patch({ dailyReport: v })}
          />
        </div>
        {smtp.dailyReport ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div>
              <Label htmlFor="smtp-admin">Your address</Label>
              <Input
                id="smtp-admin"
                value={smtp.adminEmail}
                onChange={(e) => field('adminEmail', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="smtp-hour">Not before</Label>
              <Select
                id="smtp-hour"
                value={String(smtp.dailyReportHour)}
                onChange={(e) => field('dailyReportHour', Number(e.target.value))}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {`${hour}`.padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="subtle"
              onClick={() =>
                void patch({ adminEmail: smtp.adminEmail, dailyReportHour: smtp.dailyReportHour })
              }
            >
              Save report settings
            </Button>
          </div>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-edge pt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Rules</h3>
          <Button variant="subtle" size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add rule
          </Button>
        </div>

        {adding ? (
          <RuleEditor
            rule={BLANK_RULE}
            onCancel={() => setAdding(false)}
            onSave={async (rule) => {
              await api.post('/api/notifications/rules', rule);
              setAdding(false);
              await load();
            }}
          />
        ) : null}

        {rules.length === 0 && !adding ? (
          <p className="text-xs text-muted">No rules — nothing will be sent.</p>
        ) : null}

        {rules.map((rule) =>
          editing === rule.id ? (
            <RuleEditor
              key={rule.id}
              rule={rule}
              onCancel={() => setEditing(null)}
              onSave={async (next) => {
                await api.patch(`/api/notifications/rules/${rule.id}`, next);
                setEditing(null);
                await load();
              }}
              onDelete={async () => {
                await api.del(`/api/notifications/rules/${rule.id}`);
                setEditing(null);
                await load();
              }}
            />
          ) : (
            <button
              key={rule.id}
              type="button"
              onClick={() => setEditing(rule.id)}
              className="flex w-full items-center gap-3 rounded-xl border border-edge px-3 py-2 text-left text-sm hover:bg-surface"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{rule.subject}</span>
                <span className="block text-xs text-muted">
                  {rule.kind === 'overdue'
                    ? 'When a task becomes overdue'
                    : `${rule.daysBefore ?? 0} day(s) before the due date`}
                </span>
              </span>
              <span className={cn('shrink-0 text-xs', rule.enabled ? 'text-good' : 'text-muted')}>
                {rule.enabled ? 'Active' : 'Off'}
              </span>
            </button>
          ),
        )}
      </div>

      {smtp.usersWithoutEmail.length > 0 ? (
        <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
          <p className="mb-1 font-medium">
            {smtp.usersWithoutEmail.length} student(s) have a task but no email address in Moodle,
            and are skipped:
          </p>
          <p>{smtp.usersWithoutEmail.join(', ')}</p>
          <p className="mt-1">
            Moodle hides addresses unless the token's account may see them — check the user
            policy, or the role assigned to that account.
          </p>
        </div>
      ) : null}

      {note ? <p className="text-xs text-good">{note}</p> : null}
      {error ? <ErrorNote message={error} /> : null}
    </Card>
  );
}
