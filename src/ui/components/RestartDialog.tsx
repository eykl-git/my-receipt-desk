/** "Restart demo" confirmation (design §9.1, N7). Failure leaves the demo workspace unchanged. */
import { useState } from 'react';
import { COPY } from '../copy';
import { store, useAppState } from '../store';
import { Modal } from './Modal';

export function RestartDialog() {
  const s = useAppState();
  const [failed, setFailed] = useState(false);
  const loading = s.demoLoad === 'loading';
  const restart = async () => {
    setFailed(false);
    const ok = await store.restartDemo();
    if (ok) store.closeDialog();
    else {
      // The message is shown here, in the open dialog, so the banner behind it is not repeated.
      store.dismissNotice();
      setFailed(true);
    }
  };
  return (
    <Modal
      title={COPY.restartTitle}
      onClose={() => store.closeDialog()}
      footer={
        <div className="drawer-actions">
          <button type="button" className="btn btn-primary" disabled={loading} aria-busy={loading} onClick={() => void restart()}>
            {loading ? COPY.loadingDemo : COPY.restartDemo}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={() => store.closeDialog()}>
            {COPY.cancel}
          </button>
        </div>
      }
    >
      <p>{COPY.restartConfirm}</p>
      {failed ? (
        <p className="error-text" role="alert">
          {COPY.demoAssetsFailed}
        </p>
      ) : null}
    </Modal>
  );
}
