import { renderEmail, type EmailMessage } from '@/core/index.js';

/** The email that carries a registration code. */
export function buildVerificationEmail(params: {
  to: string;
  appName: string;
  code: string;
  validForMinutes: number;
}): EmailMessage {
  const { to, appName, code, validForMinutes } = params;

  const { html, text } = renderEmail({
    appName,
    heading: 'Xác thực địa chỉ email của bạn',
    paragraphs: [
      `Dùng mã dưới đây để hoàn tất việc đăng ký tài khoản ${appName}.`,
    ],
    highlight: code,
    afterParagraphs: [
      `Mã có hiệu lực trong ${validForMinutes} phút.`,
      `Không chia sẻ mã này với bất kỳ ai, kể cả nhân viên ${appName}.`,
    ],
    reason:
      `Bạn nhận được email này vì địa chỉ này được dùng để đăng ký tài khoản tại ${appName}. ` +
      'Nếu không phải bạn, hãy bỏ qua email này.',
  });

  return {
    to,
    // The code is deliberately not in the subject: subjects show up on lock screens and notification previews
    subject: `Mã xác thực email ${appName} của bạn`,
    text,
    html,
  };
}
