import { describe, expect, it } from 'vitest';
import { allowed, parseMail, replyText, senderAuthenticated } from './mail.js';

const raw = (headers: string[], body: string) =>
  [...headers, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n');

describe('parseMail', () => {
  it('reads the headers a thread needs, and trusts the sender only when Gmail vouched for it', async () => {
    const mail = await parseMail(
      raw(
        [
          'Authentication-Results: mx.google.com; dkim=pass header.i=@acme.com; spf=pass; dmarc=pass (p=NONE) header.from=acme.com',
          'From: Dana <Dana@Acme.com>',
          'To: loop@example.com',
          'Subject: Re: Dark mode',
          'Message-ID: <b@acme.com>',
          'In-Reply-To: <loop-1@example.com>',
          'References: <a@acme.com> <loop-1@example.com>',
        ],
        'Yes please.',
      ),
      42,
      '1790',
    );
    expect(mail).toMatchObject({
      uid: 42,
      messageId: '<b@acme.com>',
      inReplyTo: '<loop-1@example.com>',
      references: ['<a@acme.com>', '<loop-1@example.com>'],
      from: 'dana@acme.com',
      subject: 'Re: Dark mode',
      threadId: '1790',
      authenticated: true,
      automatic: false,
    });
    expect(mail.text.trim()).toBe('Yes please.');
  });

  it('marks auto-replies and mail without authentication', async () => {
    const mail = await parseMail(
      raw(
        [
          'From: dana@acme.com',
          'Subject: Out of office',
          'Auto-Submitted: auto-replied',
          'Message-ID: <c@acme.com>',
        ],
        'Away.',
      ),
      1,
      null,
    );
    expect(mail).toMatchObject({ automatic: true, authenticated: false, references: [] });
  });
});

describe('senderAuthenticated', () => {
  const gmail = (results: string) => `mx.google.com;\r\n       ${results}`;
  it("trusts only Gmail's own verdict for the From domain: DMARC, or an aligned DKIM pass", () => {
    expect(
      senderAuthenticated(
        gmail('dkim=pass header.i=@acme.com; dmarc=pass (p=NONE) header.from=acme.com'),
        'd@acme.com',
      ),
    ).toBe(true);
    expect(
      senderAuthenticated(gmail('dkim=pass header.i=@mail.acme.com header.s=x'), 'd@mail.acme.com'),
    ).toBe(true);
    expect(senderAuthenticated(gmail('dkim=pass header.d=acme.com'), 'd@eu.acme.com')).toBe(true);
    expect(senderAuthenticated(gmail('spf=pass smtp.mailfrom=d@acme.com'), 'd@acme.com')).toBe(false);
    expect(senderAuthenticated(undefined, 'd@acme.com')).toBe(false);
  });

  it('refuses the forgeries that used to pass', () => {
    // DMARC passed, but for another domain than the From.
    expect(senderAuthenticated(gmail('dmarc=pass header.from=evil.example'), 'd@acme.com')).toBe(false);
    // A sender-chosen "dmarc=pass" inside a comment of Gmail's SPF result.
    expect(
      senderAuthenticated(
        gmail(
          'spf=pass (google.com: domain of dmarc=pass@evil.example designates 1.2.3.4) smtp.mailfrom=x@evil.example; dmarc=fail (p=NONE) header.from=acme.com',
        ),
        'd@acme.com',
      ),
    ).toBe(false);
    // A header Gmail did not write.
    expect(senderAuthenticated('evil.example; dmarc=pass header.from=acme.com', 'd@acme.com')).toBe(false);
    // DKIM of a lookalike domain.
    expect(senderAuthenticated(gmail('dkim=pass header.i=@notacme.com'), 'd@acme.com')).toBe(false);
  });

  it('parseMail reads only the topmost header, and distrusts two From headers', async () => {
    const forged = await parseMail(
      raw(
        [
          'Authentication-Results: mx.google.com; dmarc=fail (p=NONE) header.from=acme.com',
          'From: dana@acme.com',
          'Authentication-Results: mx.google.com; dmarc=pass header.from=acme.com',
          'Message-ID: <f@x>',
        ],
        'Delete everything.',
      ),
      1,
      null,
    );
    expect(forged.authenticated).toBe(false);
    const twoFroms = await parseMail(
      raw(
        [
          'Authentication-Results: mx.google.com; dmarc=pass header.from=evil.example',
          'From: eve@evil.example',
          'From: dana@acme.com',
          'Message-ID: <g@x>',
        ],
        'Hi',
      ),
      2,
      null,
    );
    expect(twoFroms.authenticated).toBe(false);
  });
});

describe('allowed', () => {
  it('matches an address or a whole domain, ignoring case', () => {
    expect(allowed('Dana@Acme.com', ['dana@acme.com'])).toBe(true);
    expect(allowed('kim@team.example', ['@team.example'])).toBe(true);
    expect(allowed('kim@evilteam.example', ['@team.example'])).toBe(false);
    expect(allowed('eve@acme.com', ['dana@acme.com'])).toBe(false);
  });
});

describe('replyText', () => {
  it('keeps only the new text of a reply', () => {
    expect(
      replyText('Yes.\n\nOn Sat, Oct 25, 2026 at 9:00 AM Loop <loop@example.com> wrote:\n> Which pages?'),
    ).toBe('Yes.');
    // Gmail wraps a long attribution line.
    expect(
      replyText('Yes.\n\nOn Sat, Oct 25, 2026 at 9:00 AM Loop Engineering <\nloop@example.com> wrote:\n> q'),
    ).toBe('Yes.');
    // Another language's attribution: a line naming an address and ending with a colon, with
    // Gmail's direction marks, and wrapped over three lines.
    expect(replyText('כן.\n\nבתאריך יום ש׳, 25 באוק׳ 2026, Loop <loop@example.com> כתב/ה:\n> q')).toBe('כן.');
    expect(
      replyText(
        'כן.\n\n\u200fבתאריך יום ש׳, 25 באוק׳ 2026 ב-9:00 מאת \u202aLoop\u202c <\u200e\nloop@example.com\u200e>:\u200f\n> q',
      ),
    ).toBe('כן.');
    expect(
      replyText('Yes.\nOn Sat, Oct 25, 2026 at 9:00 AM Loop\nEngineering <loop@example.com>\nwrote:\n> q'),
    ).toBe('Yes.');
    // Written under the quote.
    expect(
      replyText('On Sat, Oct 25, 2026 at 9:00 AM Loop <loop@example.com> wrote:\n> Which?\n\nBoth.'),
    ).toBe('Both.');
    // Not a quote: a line that names an address, and a "From:" in the text.
    expect(replyText('Ask Dana <dana@acme.com>:\nshe knows.')).toBe('Ask Dana <dana@acme.com>:\nshe knows.');
    expect(replyText('From: the home page, remove the banner.')).toBe(
      'From: the home page, remove the banner.',
    );
    expect(replyText('Both.\n\n-----Original Message-----\nFrom: x')).toBe('Both.');
    expect(replyText('> quoted\nmine\n> more')).toBe('mine');
    expect(replyText('A new task\nwith two lines')).toBe('A new task\nwith two lines');
  });
});
