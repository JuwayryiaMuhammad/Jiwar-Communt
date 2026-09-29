import {
  renderDelegationEmail,
  renderMembershipEndedEmail,
} from './household-emails';

describe('household emails', () => {
  const removed = {
    kind: 'removed' as const,
    compoundName: 'Nile Gardens',
    unitCode: 'A-101',
    reason: 'Moved <away> & "done"',
  };

  it('removal: English, with the reason escaped in HTML and plain in text', () => {
    const email = renderMembershipEndedEmail('en', removed);
    expect(email.subject).toBe('You were removed from a household on Jiwar');
    expect(email.html).toContain('dir="ltr"');
    expect(email.html).toContain('Moved &lt;away&gt; &amp; &quot;done&quot;');
    expect(email.html).not.toContain('<away>');
    expect(email.text).toContain('Reason: Moved <away> & "done"');
    expect(email.text).toContain('A-101');
  });

  it('removal and rejection: Arabic, right to left', () => {
    const ar = renderMembershipEndedEmail('ar', removed);
    expect(ar.subject).toBe('تمت إزالتك من أسرة وحدة على جوار');
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text.startsWith('‏')).toBe(true);
    const rejected = renderMembershipEndedEmail('ar', {
      ...removed,
      kind: 'rejected',
    });
    expect(rejected.subject).toBe('تم رفض طلب انضمامك إلى أسرة على جوار');
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
