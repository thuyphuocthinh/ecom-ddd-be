import { renderEmail, type EmailMessage } from '@/core/index.js';

/** Tells the owner a Google account was just linked to their account. */
export function buildGoogleLinkedEmail(params: {
  to: string;
  appName: string;
}): EmailMessage {
  const { to, appName } = params;

  const { html, text } = renderEmail({
    appName,
    heading: 'Tài khoản Google đã được liên kết',
    paragraphs: [
      `Một tài khoản Google vừa được liên kết với tài khoản ${appName} của bạn. Từ giờ bạn có thể đăng nhập bằng Google.`,
      'Nếu chính bạn đã làm việc này thì bạn không cần làm gì thêm.',
      'Nếu không phải bạn, hãy đổi mật khẩu ngay và hủy liên kết Google trong phần cài đặt tài khoản.',
    ],
    reason: `Bạn nhận được email này vì có người đăng nhập vào tài khoản ${appName} gắn với địa chỉ này bằng Google lần đầu tiên.`,
  });

  return {
    to,
    subject: `Google đã được liên kết với tài khoản ${appName} của bạn`,
    text,
    html,
  };
}
