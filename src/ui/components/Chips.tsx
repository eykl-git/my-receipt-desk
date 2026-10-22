/** Pill status chips: icon + text, never colour alone (brief §24). */
import type { CaseGroup } from '../../domain/matching/caseView';
import { COPY } from '../copy';
import { IconAlert, IconArrowRight, IconCheck, IconLock, IconRule } from '../icons';

export function GroupChip({ group }: { group: CaseGroup }) {
  if (group === 'recorded') {
    return (
      <span className="chip chip-green">
        <IconCheck />
        {COPY.groups.recorded}
      </span>
    );
  }
  if (group === 'ready') {
    return (
      <span className="chip chip-neutral">
        <IconArrowRight />
        {COPY.groups.ready}
      </span>
    );
  }
  return (
    <span className="chip chip-amber">
      <IconAlert />
      {COPY.groups.needs_decision}
    </span>
  );
}

export function RuleChip({ text }: { text: string }) {
  return (
    <span className="chip chip-teal">
      <IconRule />
      {text}
    </span>
  );
}

export function AmberChip({ text }: { text: string }) {
  return (
    <span className="chip chip-amber">
      <IconAlert />
      {text}
    </span>
  );
}

export function NeutralChip({ text }: { text: string }) {
  return <span className="chip chip-muted">{text}</span>;
}

export function LockChip({ text }: { text: string }) {
  return (
    <span className="chip chip-grey">
      <IconLock />
      {text}
    </span>
  );
}
