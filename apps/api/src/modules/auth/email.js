import { env } from '../../config/env.js';

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character];
  });
}

async function sendTransactionalEmail({ email, actionUrl, subject, text, actionLabel }) {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    if (env.NODE_ENV !== 'production') return { previewUrl: actionUrl };
    throw new Error('Transactional email is not configured');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject,
      text,
      html: `<p>${escapeHtml(text.split('\n\n')[0])}</p><p><a href="${escapeHtml(actionUrl)}">${escapeHtml(actionLabel)}</a></p><p>${escapeHtml(text.split('\n\n').slice(1).join(' '))}</p>`,
    }),
  });

  if (!response.ok) throw new Error(`Email provider rejected the message (${response.status})`);
  return {};
}

export function sendPasswordResetEmail(email, resetUrl) {
  return sendTransactionalEmail({
    email,
    actionUrl: resetUrl,
    subject: 'Reset your SocietyOS password',
    text: `Use this one-time link to reset your SocietyOS password. It expires in 30 minutes.\n\n${resetUrl}`,
    actionLabel: 'Reset password',
  });
}

export function sendEmailVerificationEmail(email, verificationUrl) {
  return sendTransactionalEmail({
    email,
    actionUrl: verificationUrl,
    subject: 'Verify your SocietyOS email address',
    text: `Verify your email address to activate your SocietyOS account. This link expires in 24 hours.\n\n${verificationUrl}`,
    actionLabel: 'Verify email address',
  });
}

export function sendSocietyInvitationEmail(email, invitationUrl, { societyName, role, expiresAt }) {
  const expiry = new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(expiresAt);
  return sendTransactionalEmail({
    email,
    actionUrl: invitationUrl,
    subject: `Join ${societyName} on SocietyOS`,
    text: `You have been invited to join ${societyName} as a ${role.replaceAll('_', ' ').toLowerCase()} on SocietyOS.\n\n${invitationUrl}\n\nThis invitation expires on ${expiry}. Create an account with this email address to accept it.`,
    actionLabel: 'Accept society invitation',
  });
}

export function sendGateApprovalEmail(
  email,
  approvalUrl,
  { societyName, visitorName, flatLabel, expiresAt },
) {
  const expiry = new Intl.DateTimeFormat('en-IN', {
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(expiresAt);
  return sendTransactionalEmail({
    email,
    actionUrl: approvalUrl,
    subject: `Visitor approval requested for ${flatLabel}`,
    text: `${visitorName} is waiting at the gate and requested access to ${flatLabel} at ${societyName}. Sign in to SocietyOS to approve or decline this request. The request expires at ${expiry}.\n\n${approvalUrl}`,
    actionLabel: 'Review gate request',
  });
}
