const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL

export async function sendSlackNotification(type: string, data: Record<string, unknown>): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return

  const messages: Record<string, string> = {
    contact: `📬 New contact from ${data.firstName} ${data.lastName} (${data.email})${data.company ? ` at ${data.company}` : ''}`,
    demo: `🎯 Demo request from ${data.firstName} ${data.lastName} (${data.email})${data.company ? ` at ${data.company}` : ''}`,
    support: `🆘 Support request from ${data.firstName} ${data.lastName} (${data.email})`,
    newsletter: `📧 Newsletter signup: ${data.email}`,
    waitlist: `⏳ Waitlist signup: ${data.email}`,
    faq_draft: `❓ New FAQ draft needs review: "${data.question}" — ${data.url}`,
    faq_freshness: `🔄 FAQ freshness: ${data.needsReview} entr${data.needsReview === 1 ? 'y needs' : 'ies need'} review, ${data.unchangedCount} re-verified unchanged — ${data.url}`,
  }

  const text = messages[type] ?? `New submission (${type}): ${JSON.stringify(data)}`

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
  } catch {
    // Slack notifications are best-effort — don't fail the request
  }
}
