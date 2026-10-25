import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, Modal } from "./components";
import {
  cancelConfirmations,
  currentConfirmation,
  finishConfirmation,
  subscribeConfirmations,
} from "./confirmation";
import type { Confirmation } from "./confirmation";

export function ConfirmationDialogHost() {
  const request = useSyncExternalStore(
    subscribeConfirmations,
    currentConfirmation,
  );
  useEffect(() => cancelConfirmations, []);
  return request ? (
    <ConfirmationDialog key={request.id} request={request} />
  ) : null;
}

function ConfirmationDialog({ request }: { request: Confirmation }) {
  const descriptionId = useId();
  const confirmed = useRef(false);
  return (
    <Modal
      title="确认操作"
      className="confirmation-dialog"
      descriptionId={descriptionId}
      showError={false}
      onClose={() => finishConfirmation(request.id, confirmed.current)}
    >
      {(requestClose) => (
        <>
          <div className="confirmation-message">
            <TriangleAlert size={22} aria-hidden="true" />
            <p id={descriptionId}>{request.message}</p>
          </div>
          <div className="dialog-actions">
            <Button data-modal-autofocus onClick={requestClose}>
              取消
            </Button>
            <Button
              danger
              onClick={() => {
                // Only the first close request decides the result, including
                // when Escape or the backdrop already started the exit motion.
                if (requestClose()) confirmed.current = true;
              }}
            >
              确认
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
