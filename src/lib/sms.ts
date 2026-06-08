// SMS via Twilio (HTTP REST — pas de SDK). Fallback console si non configuré.
export async function sendSms(opts: { to: string; message: string }): Promise<boolean> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  if (accountSid && authToken && from) {
    const url  = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    try {
      const resp = await fetch(url, {
        method:  'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ To: opts.to, From: from, Body: opts.message }).toString(),
      });
      if (!resp.ok) {
        console.error('[sms/twilio] Erreur:', await resp.text());
        return false;
      }
      return true;
    } catch (err) {
      console.error('[sms/twilio] Exception:', err);
      return false;
    }
  }

  console.log(`[sms] Pas de fournisseur SMS → ${opts.to}: ${opts.message}`);
  return false;
}
