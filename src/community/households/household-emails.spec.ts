import {
  renderDelegationEmail,
  renderJoinRejectedEmail,
  renderMemberRemovedEmail,
} from './household-emails';

describe('household emails', () => {
  const removed = {
    compoundName: 'Nile Gardens',
    unitCode: 'A-101',
    reason: 'Moved <away> & "done"',
  };

  it('removal: English, with the reason escaped in HTML and plain in text', () => {
    const email = renderMemberRemovedEmail('en', removed);
    expect(email.subject).toBe('You were removed from a household on Jiwar');
    expect(email.html).toContain('dir="ltr"');
    expect(email.html).toContain('Moved &lt;away&gt; &amp; &quot;done&quot;');
    expect(email.html).not.toContain('<away>');
    expect(email.text).toContain('Reason: Moved <away> & "done"');
    expect(email.text).toContain('A-101');
  });

  it('removal: Arabic, right to left', () => {
    const ar = renderMemberRemovedEmail('ar', removed);
    expect(ar.subject).toBe('تمت إزالتك من أسرة وحدة على جوار');
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text.startsWith('\u200f')).toBe(true);
  });

  it('rejection: its own message in English, never the removal one, reason escaped', () => {
    const en = renderJoinRejectedEmail('en', removed);
    expect(en.subject).toBe(
      'Your request to join a household on Jiwar was not approved',
    );
    expect(en.text).toContain('did not approve your request to join');
    expect(en.text).not.toMatch(/removed|no longer a member/);
    expect(en.html).toContain('Moved &lt;away&gt; &amp; &quot;done&quot;');
    expect(en.html).not.toContain('<away>');
    expect(en.text).toContain('Reason: Moved <away> & "done"');
  });

  it('rejection: Arabic, right to left', () => {
    const ar = renderJoinRejectedEmail('ar', removed);
    expect(ar.subject).toBe(
      'لم تتم الموافقة على طلب انضمامك إلى أسرة على جوار',
    );
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain('لم توافق إدارة المجمع');
    expect(ar.text).not.toContain('لم تعد فردًا');
    expect(ar.html).toContain('Moved &lt;away&gt;');
  });

  it('delegation: scopes, end date and the never-delegable note; the end reason when it ends', () => {
    const base = {
      compoundName: 'Nile Gardens',
      unitCode: 'A-101',
      delegatorName: 'Primary <P>',
      delegateName: 'Member M',
      scopes: ['household', 'workers'] as ('household' | 'workers')[],
      expiresAt: new Date('2027-03-01T00:00:00Z'),
    };
    const created = renderDelegationEmail('en', {
      ...base,
      event: { kind: 'created' },
    });
    expect(created.subject).toBe('New delegation on Jiwar');
    expect(created.text).toContain('manage domestic workers');
    expect(created.text).toContain('2027-03-01');
    expect(created.text).toContain('never covers money');
    expect(created.html).toContain('Primary &lt;P&gt;');

    const ended = renderDelegationEmail('ar', {
      ...base,
      event: { kind: 'ended', reason: 'primary_changed' },
    });
    expect(ended.subject).toBe('انتهى تفويض على جوار');
    expect(ended.text).toContain('تغيّر الساكن الرئيسي للوحدة');
    expect(ended.html).toContain('dir="rtl"');
  });
});
