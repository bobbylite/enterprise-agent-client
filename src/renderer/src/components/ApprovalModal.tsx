import { useEffect, useState } from 'react';
import type { ApprovalRequest } from '@shared/types';

export function ApprovalModal() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);

  useEffect(() => {
    return window.agent.onChatEvent((event) => {
      if (event.type === 'approval-required') setRequest(event.request);
    });
  }, []);

  if (!request) return null;

  const choose = (choice: 'once' | 'always' | 'deny') => {
    const current = request;
    setRequest(null);
    void window.agent.respondApproval(current.id, choice);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <p className="eyebrow">Tool approval</p>
        <h2 id="approval-title">
          {request.serverName} · {request.toolName}
        </h2>
        <p className="muted">
          {request.readOnlyHint ? 'Marked read-only. ' : ''}
          {request.allowAlways
            ? 'Allow it once, remember it, or deny this call.'
            : 'This session asks for approval on every tool call.'}
        </p>
        <pre className="args">{request.argumentsText}</pre>
        <div className="row">
          <button type="button" className="ghost" onClick={() => choose('deny')}>
            Deny
          </button>
          <button type="button" className="primary" onClick={() => choose('once')}>
            Allow once
          </button>
          {request.allowAlways ? (
            <button type="button" className="primary" onClick={() => choose('always')}>
              Always allow
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
