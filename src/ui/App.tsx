/**
 * App shell (design §9.3): header, persistent notice, tour bar, counters and
 * three columns at ≥1024 px; accessible tabs below that.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { COPY } from './copy';
import { useMediaQuery } from './hooks';
import { requestLeavePanel } from './panelActions';
import type { TabId } from './state';
import { store, useAppState } from './store';
import { AddReceiptsDialog } from './components/AddReceiptsDialog';
import { CaseDrawer } from './components/CaseDrawer';
import { CompareDialog } from './components/CompareDialog';
import { RestartDialog } from './components/RestartDialog';
import { Counters } from './components/Counters';
import { Decisions } from './components/Decisions';
import {
  AuditDialog,
  BaselineHistoryDialog,
  DiscardDialog,
  HistoryDialog,
  PreviewDialog,
  PrivacyDialog,
  RecheckDialog,
  ResetDialog,
  StorageProblemsDialog,
  SuspendDialog,
  VoidDialog,
} from './components/Dialogs';
import { InvoiceDrawer } from './components/InvoiceDrawer';
import { missingEvidence } from '../domain/ledger/evidence';
import { Header } from './components/Header';
import { ExportsDialog, ImportKnowledgeDialog } from './components/ExportsDialog';
import { ImportWizard } from './components/ImportWizard';
import { KnowledgeSpace } from './components/KnowledgeSpace';
import { Modal } from './components/Modal';
import { RuleDraftFooter, RuleDraftPanel } from './components/RuleDraftPanel';
import { SpreadsheetView } from './components/SpreadsheetView';
import { TourBar } from './components/TourBar';
import { TransactionDrawer } from './components/TransactionDrawer';
import { YourData } from './components/YourData';
import { IconClose, IconInfo } from './icons';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'data', label: COPY.yourData },
  { id: 'knowledge', label: COPY.knowledgeSpace },
  { id: 'decisions', label: COPY.decisions },
];

function Columns() {
  const s = useAppState();
  const wide = useMediaQuery('(min-width: 1024px)');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  if (wide) {
    return (
      <main className="columns">
        <YourData />
        <KnowledgeSpace />
        <Decisions />
      </main>
    );
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    store.setTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };
  return (
    <main className="tabs">
      <div className="tablist" role="tablist" aria-label={COPY.tabsLabel}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={s.tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={s.tab === t.id ? 0 : -1}
            className="tab"
            onClick={() => store.setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${s.tab}`} aria-labelledby={`tab-${s.tab}`} className="tabpanel">
        {s.tab === 'data' ? <YourData /> : s.tab === 'knowledge' ? <KnowledgeSpace /> : <Decisions />}
      </div>
    </main>
  );
}

function Drawer() {
  const s = useAppState();
  const d = s.drawer;
  if (!d) return null;
  if (d.kind === 'case') return <CaseDrawer key={d.receiptId} receiptId={d.receiptId} />;
  if (d.kind === 'transaction') return <TransactionDrawer key={d.transactionId} transactionId={d.transactionId} />;
  if (d.kind === 'invoice') return <InvoiceDrawer key={d.payableId} payableId={d.payableId} />;
  return (
    <Modal variant="drawer" testId="drawer" title={COPY.draftTitle} onClose={() => requestLeavePanel('close')} footer={<RuleDraftFooter />}>
      <RuleDraftPanel />
    </Modal>
  );
}

function DialogHost() {
  const { dialog } = useAppState();
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'audit':
      return <AuditDialog />;
    case 'privacy':
      return <PrivacyDialog />;
    case 'reset':
      return <ResetDialog />;
    case 'history':
      return <HistoryDialog ruleId={dialog.ruleId} />;
    case 'suspend':
      return <SuspendDialog ruleId={dialog.ruleId} />;
    case 'preview':
      return <PreviewDialog ruleId={dialog.ruleId} />;
    case 'baselineHistory':
      return <BaselineHistoryDialog />;
    case 'discard':
      return <DiscardDialog ruleId={dialog.ruleId} />;
    case 'addReceipts':
      return <AddReceiptsDialog />;
    case 'import':
      return <ImportWizard />;
    case 'compare':
      return <CompareDialog ruleRef={dialog.ruleRef} />;
    case 'restart':
      return <RestartDialog />;
    case 'exports':
      return <ExportsDialog />;
    case 'importKnowledge':
      return <ImportKnowledgeDialog />;
    case 'recheck':
      return <RecheckDialog key={dialog.ruleId} ruleId={dialog.ruleId} />;
    case 'void':
      return <VoidDialog key={`${dialog.mode}|${dialog.ledgerEntryId}`} ledgerEntryId={dialog.ledgerEntryId} mode={dialog.mode} receiptId={dialog.receiptId} ruleId={dialog.ruleId} />;
    case 'storageProblems':
      return <StorageProblemsDialog />;
  }
}

/**
 * "Delete data in this workspace" on the newer-version banner (§11.5). The
 * deletion can't be undone, so it asks first like the Reset menu (§11.6,
 * A-S5-12). Cancel returns focus to the button.
 */
function DeleteNewerData() {
  const s = useAppState();
  const [confirming, setConfirming] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      openerRef.current?.focus();
    }
  }, [confirming]);
  const target = store.newerWorkspace();
  if (!target) return null;
  if (!confirming) {
    return (
      <button ref={openerRef} type="button" className="btn btn-secondary btn-small" disabled={s.busy} onClick={() => setConfirming(true)}>
        {COPY.deleteWorkspaceData}
      </button>
    );
  }
  const text = COPY.deleteNewerConfirm[target];
  return (
    <div className="confirm-box" role="group" aria-label={text} data-testid="delete-newer-confirm">
      <p>{text}</p>
      <div className="button-row">
        <button
          type="button"
          className="btn btn-danger"
          disabled={s.busy}
          onClick={() => {
            setConfirming(false);
            void store.deleteNewerWorkspace();
          }}
        >
          {COPY.confirmDelete}
        </button>
        <button
          ref={cancelRef}
          type="button"
          className="btn btn-tertiary"
          onClick={() => {
            returnFocus.current = true;
            setConfirming(false);
          }}
        >
          {COPY.cancel}
        </button>
      </div>
    </div>
  );
}

/** Shown only when stored records failed their check or evidence is missing (§11.5). */
function StorageProblemsBanner() {
  useAppState();
  const snap = store.snapshot();
  const problems = store.storageProblems().length;
  const broken = missingEvidence(snap.ledger, snap).size;
  if (problems === 0 && broken === 0) return null;
  return (
    <div className="banner banner-error" role="status" data-testid="storage-problems-banner">
      <IconInfo />
      <span>{COPY.storageProblemsNote}</span>
      <button type="button" className="btn btn-secondary btn-small" onClick={() => store.openDialog({ kind: 'storageProblems' })}>
        {COPY.storageProblems}
      </button>
    </div>
  );
}

export function App() {
  const s = useAppState();
  return (
    <div className="app">
      <Header />
      <p className="notice-bar" role="note">
        {COPY.notice}
      </p>
      {s.storage ? (
        <div className="banner banner-error banner-wrap" role="alert" data-testid="storage-banner">
          <IconInfo />
          <span>{COPY.storageBanner[s.storage]}</span>
          {s.storage === 'newer_version' ? <DeleteNewerData /> : null}
        </div>
      ) : null}
      <StorageProblemsBanner />
      {s.notice ? (
        <div className={`banner banner-${s.notice.tone}`} role={s.notice.tone === 'error' ? 'alert' : 'status'}>
          <IconInfo />
          <span>{s.notice.text}</span>
          <button type="button" className="btn btn-tertiary btn-small" onClick={() => store.dismissNotice()}>
            <IconClose />
            {COPY.close}
          </button>
        </div>
      ) : null}
      {s.ready ? (
        <>
          <TourBar />
          <Counters />
          {s.view === 'spreadsheet' ? <SpreadsheetView /> : <Columns />}
        </>
      ) : null}
      <Drawer />
      <DialogHost />
      <div className="sr-only" aria-live="polite" data-testid="live-region">
        {s.live}
      </div>
    </div>
  );
}
