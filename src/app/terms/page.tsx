import type { Metadata } from 'next'
import Link from 'next/link'
import { SiteFooter } from '@/components/site-footer'

export const metadata: Metadata = {
  title: 'Terms of Service — Discord Quests',
  description: 'Terms of Service for Discord Quests.',
}

const sections = [
  {
    title: '1. Acceptance of Terms',
    body: 'By accessing or using this application, you agree to be bound by these Terms of Service and all applicable laws and regulations. If you do not agree with any part of these terms, you may not use the service. These terms apply to every visitor and user of the application, whether or not you choose to connect a Discord account. We reserve the right to update these terms at any time without prior notice, and continued use of the service after changes are made constitutes acceptance of the revised terms.',
  },
  {
    title: '2. Description of the Service',
    body: 'Discord Quests is a self-hosted tool that automates the completion of Discord quests on behalf of a single user account. The application authenticates using your own Discord user token, reads the quests available to your account, and sends the activity signals Discord requires in order to register quest progress. The service is provided for personal, non-commercial use on infrastructure that you control. It is not affiliated with, endorsed by, or sponsored by Discord Inc. or any game publisher.',
  },
  {
    title: '3. Eligibility and Account Responsibility',
    body: 'You may use this service only with a Discord account that you own or are authorized to control. You are solely responsible for safeguarding your Discord token, for all activity performed through your account, and for any consequences that may arise from automating actions on your account. Automated interaction with Discord, including through user tokens, may violate the Discord Terms of Service or Discord Developer Policies and can result in restrictions, suspension, or termination of your Discord account. You assume all associated risk, and the operators of this application accept no responsibility for actions taken against your account by Discord.',
  },
  {
    title: '4. Acceptable Use',
    body: 'You agree not to use the service for any unlawful purpose or in any way that could damage, disable, overburden, or impair Discord\'s systems. You agree not to attempt to gain unauthorized access to other accounts, not to resell or commercialize access to the service, and not to use the service to harass, defraud, or harm any person or entity. You further agree to respect rate limits and technical safeguards, and to avoid any activity that interferes with the normal operation of the platform. We may suspend or terminate access to the service for conduct that we determine, in our sole discretion, violates these terms.',
  },
  {
    title: '5. Intellectual Property',
    body: 'The application code, design, and original content are owned by the developer and are protected by applicable intellectual property laws. All trademarks, logos, game names, and quest content that appear in the application belong to their respective owners, including Discord Inc. and its partners. Nothing in these terms grants you any right, title, or interest in the service or in any third-party content displayed within it. You may not copy, modify, distribute, or create derivative works based on the service without prior written permission.',
  },
  {
    title: '6. No Warranty',
    body: 'The service is provided on an "as is" and "as available" basis, without warranties of any kind, either express or implied. This includes, without limitation, implied warranties of merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the service will be uninterrupted, error-free, secure, or that quest progress will always register correctly with Discord. Quest availability, reward structure, and platform behavior are controlled entirely by Discord and may change at any time without notice, which may cause parts of the service to stop functioning.',
  },
  {
    title: '7. Limitation of Liability',
    body: 'To the fullest extent permitted by law, the developer of this application shall not be liable for any indirect, incidental, special, consequential, or punitive damages arising out of or related to your use of the service. This includes, but is not limited to, loss of Discord account access, loss of rewards or quest progress, loss of data, or any other losses arising from account moderation actions taken by Discord. Your sole and exclusive remedy for any dissatisfaction with the service is to stop using it and to log out, which clears your stored credentials.',
  },
  {
    title: '8. Changes to the Service',
    body: 'We reserve the right to modify or discontinue the service, or any part of it, at any time and without notice. Because the application is self-hosted, you are also free to stop running it at any moment. Features described in these terms or in the application interface may be added, changed, or removed in future versions. We shall not be liable to you or to any third party for any modification, suspension, or discontinuation of the service.',
  },
  {
    title: '9. Contact',
    body: 'If you have any questions about these Terms of Service, you can reach out through the developer\'s website at deadlock.ophelia.website. Please include a clear description of your question or concern so that it can be addressed appropriately. Feedback about the service is also welcome and helps improve future versions of the application.',
  },
]

export default function TermsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Discord Quests" className="h-7 w-7" />
            <span className="text-[15px] font-semibold">Discord Quests</span>
          </div>
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            Back
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">
        <h1 className="text-2xl font-semibold">Terms of Service</h1>
        <p className="mt-1 text-sm text-muted-foreground">Last updated: October 2025</p>

        <div className="mt-8 space-y-8">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="text-base font-medium">{section.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{section.body}</p>
            </section>
          ))}
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}
