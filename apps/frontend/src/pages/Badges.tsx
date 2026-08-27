import { useCallback, useEffect, useState } from 'react';
import type { BadgeAdmin } from '@moodify/shared';
import { Award, Check } from 'lucide-react';
import { api, assetUrl, cn, errorMessage } from '@/lib/api';
import { Button, Card, EmptyState, ErrorNote, Spinner } from '@/ui';

/**
 * Badges: the catalogue Moodify has seen, and the descriptions written for them here.
 *
 * Moodle has no endpoint that lists the badges a course *has* — only the ones a given
 * user holds (§9.2) — so this page can only show badges somebody has actually earned.
 * A badge nobody has yet appears the day it is first awarded. The README says the same
 * thing, so this is not mistaken for a sync bug.
 *
 * The description written here is separate from Moodle's own, which every discovery run
 * overwrites from the source. Both are kept; the pop-up prefers this one.
 */
export default function Badges() {
  const [badges, setBadges] = useState<BadgeAdmin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBadges(await api.get<BadgeAdmin[]>('/api/badges'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !badges) return <ErrorNote message={error} />;
  if (!badges) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Badges</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          What each badge means, in your words. The text here is what a student sees when
          they click a badge on a dashboard — Moodle's own description is shown underneath
          each field for reference and is left untouched.
        </p>
      </div>

      {error ? <ErrorNote message={error} /> : null}

      {badges.length === 0 ? (
        <EmptyState
          icon={<Award className="h-6 w-6" />}
          title="No badges yet"
          hint="Moodle only reports badges that have been awarded to somebody, so a badge appears here the first time a student earns it."
        />
      ) : (
        <div className="space-y-3">
          {badges.map((badge) => (
            <BadgeRow key={badge.id} badge={badge} onSaved={() => void load()} />
          ))}
        </div>
      )}
    </div>
  );
}

function BadgeRow({ badge, onSaved }: { badge: BadgeAdmin; onSaved: () => void }) {
  const [draft, setDraft] = useState(badge.customDescription ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const image = assetUrl(badge.imageUrl);
  const dirty = draft !== (badge.customDescription ?? '');

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/api/badges/${badge.id}`, { customDescription: draft });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 sm:flex-row">
      {image ? (
        <img src={image} alt="" className="h-20 w-20 shrink-0 self-start object-contain" />
      ) : (
        <span className="grid h-20 w-20 shrink-0 self-start place-items-center rounded-full bg-white/8">
          <Award className="h-8 w-8 text-muted" aria-hidden="true" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium">{badge.name}</h2>
        <p className="text-xs text-muted">
          {badge.courseName ?? 'Site-wide badge'} · held by {badge.holders}{' '}
          {badge.holders === 1 ? 'student' : 'students'}
        </p>

        <textarea
          value={draft}
          rows={3}
          maxLength={2000}
          placeholder="What this badge is for…"
          onChange={(e) => setDraft(e.target.value)}
          className={cn(
            'mt-2 w-full rounded-xl border border-edge bg-ground-soft/80 px-3 py-2 text-sm text-ink',
            'placeholder:text-muted/70 focus:outline-none focus:ring-2 focus:ring-accent/60',
          )}
        />

        {badge.description ? (
          <p className="mt-1 text-xs text-muted">
            In Moodle: <span className="italic">{badge.description}</span>
          </p>
        ) : null}

        {error ? <ErrorNote message={error} className="mt-2" /> : null}

        <div className="mt-2 flex items-center gap-2">
          <Button variant="subtle" size="sm" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <Spinner className="h-4 w-4" /> : null}
            Save
          </Button>
          {saved ? (
            <span className="flex items-center gap-1 text-xs text-good">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
