// Admin. Data: shelter (approve or reject new shelters) and reporting (portal-wide figures).
// Emails are sent by email-worker; in the cluster Mailpit catches them, linked below when configured.
import { api, config } from '../api.js';
import { esc, formatDate, statusBadge, emptyState, toast, $$ } from '../ui.js';

export default async function admin({ main, rerender }) {
  const [all, summary] = await Promise.all([
    api.get('/shelters?status=all'),
    api.get('/reports/summary').catch(() => null),
  ]);
  const pending = all.filter((s) => s.status === 'pending');
  const stat = (label, value) => `<div class="stat"><div class="n">${esc(String(value))}</div><div class="l">${esc(label)}</div></div>`;

  main.innerHTML = `<div class="wrap">
    <div class="page-head"><div><h1>Admin</h1><p class="muted">${pending.length} shelter${pending.length === 1 ? '' : 's'} waiting for approval.</p></div>
      <a class="btn btn-outline" href="#/reports">Full report</a></div>

    ${summary ? `<section class="stats" style="margin-bottom:28px">
      ${stat('Approved shelters', summary.shelters?.approved || 0)}
      ${stat('Pets listed', summary.pets.total)}
      ${stat('Applications', summary.applications.total)}
      ${stat('Emails sent', summary.emailsSent)}
    </section>` : ''}

    <section>
      <div class="section-head"><h2>Shelter registrations</h2></div>
      ${all.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Shelter</th><th>District</th><th>Contact</th><th>Registered</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${all.map((s) => `<tr>
          <td><strong>${esc(s.name)}</strong></td><td>${esc(s.district)}</td><td class="small">${esc(s.email)}</td>
          <td class="small">${esc(formatDate(s.createdAt))}</td><td>${statusBadge(s.status === 'pending' ? 'submitted' : s.status)}</td>
          <td style="white-space:nowrap">${s.status === 'pending'
            ? `<button class="btn btn-primary btn-small" data-approve="${esc(s.id)}" data-status="approved">Approve</button> <button class="btn btn-danger btn-small" data-approve="${esc(s.id)}" data-status="rejected">Reject</button>`
            : `<a class="btn btn-quiet btn-small" href="#/shelters/${esc(s.id)}">View</a>`}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState('No shelters yet', 'Shelters appear here when their staff sign up.')}
    </section>

    ${config.mailUrl ? `<section class="section">
      <div class="section-head"><h2>Outgoing email</h2></div>
      <div class="panel"><p>Emails are queued by notification and sent by email-worker. In this environment they are caught by Mailpit, so no real address is contacted.</p>
        <a class="btn btn-outline" href="${esc(config.mailUrl)}" target="_blank" rel="noopener">Open the mail inbox</a></div>
    </section>` : ''}
  </div>`;

  for (const b of $$('[data-approve]', main)) {
    b.addEventListener('click', async () => {
      if (b.dataset.status === 'rejected' && !confirm('Reject this shelter? Its staff will not be able to list pets.')) return;
      try { await api.patch(`/shelters/${encodeURIComponent(b.dataset.approve)}/approval`, { status: b.dataset.status }); toast(b.dataset.status === 'approved' ? 'Shelter approved' : 'Shelter rejected'); rerender(); }
      catch (ex) { toast(ex.message, 'bad'); }
    });
  }
}
