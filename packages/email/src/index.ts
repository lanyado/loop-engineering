export {
  answerFor,
  EmailChannel,
  type Clarifier,
  type ClarifyMail,
  type EmailChannelOptions,
} from './channel.js';
export { EmailConfigError, loadEmailConfig, type EmailConfig, type EmailConfigResult } from './config.js';
export { FakeMailbox } from './fake.js';
export { GmailMailbox } from './gmail.js';
export {
  allowed,
  parseMail,
  replyText,
  senderAuthenticated,
  type IncomingMail,
  type MailCursor,
  type Mailbox,
  type OutgoingMail,
} from './mail.js';
