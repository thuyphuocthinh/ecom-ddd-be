import { renderEmail, type EmailMessage } from '@/core/index.js';

/** The email that carries the code for resetting a forgotten password. */
export function buildPasswordResetCodeEmail(params: {
  to: string;
  appName: string;
  code: string;
  validForMinutes: number;
}): EmailMessage {
  const { to, appName, code, validForMinutes } = params;

  const { html, text } = renderEmail({
    appName,
    heading: 'Đặt lại mật khẩu của bạn',
    paragraphs: [
      `Dùng mã dưới đây để đặt lại mật khẩu tài khoản ${appName} của bạn.`,
    ],
    highlight: code,
    afterParagraphs: [
      `Mã có hiệu lực trong ${validForMinutes} phút.`,
      `Không chia sẻ mã này với bất kỳ ai, kể cả nhân viên ${appName}.`,
    ],
    reason:
      `Bạn nhận được email này vì có người yêu cầu đặt lại mật khẩu cho địa chỉ này tại ${appName}. ` +
      'Nếu không phải bạn, hãy bỏ qua email này: mật khẩu của bạn chưa bị thay đổi.',
  });

  return {
    to,
    // The code is deliberately not in the subject: subjects show up on lock screens and notification previews
    subject: `Mã đặt lại mật khẩu ${appName} của bạn`,
    text,
    html,
  };
}

/** Tells the owner their password was just changed, so a change they did not make is noticed. */
export function buildPasswordChangedEmail(params: {
  to: string;
  appName: string;
}): EmailMessage {
  const { to, appName } = params;

  const { html, text } = renderEmail({
    appName,
    heading: 'Mật khẩu của bạn vừa được thay đổi',
    paragraphs: [
      `Mật khẩu tài khoản ${appName} của bạn vừa được thay đổi, và các thiết bị khác đã bị đăng xuất.`,
      'Nếu chính bạn đã làm việc này thì bạn không cần làm gì thêm.',
      'Nếu không phải bạn, hãy đặt lại mật khẩu ngay bằng chức năng "Quên mật khẩu" để lấy lại quyền kiểm soát tài khoản.',
    ],
    reason: `Bạn nhận được email này vì mật khẩu của tài khoản ${appName} gắn với địa chỉ này vừa được thay đổi.`,
  });

  return {
    to,
    subject: `Mật khẩu ${appName} của bạn vừa được thay đổi`,
    text,
    html,
  };
}
