import type { Metadata } from 'next'
import Link from 'next/link'
import { SiteFooter } from '@/components/site-footer'

export const metadata: Metadata = {
  title: 'Privacy Policy — Discord Quests',
  description: 'Privacy Policy for Discord Quests.',
}

const sections = [
  {
    title: '1. Overview',
    body: 'This Privacy Policy explains what information the application collects, how it is used, and the choices you have. Discord Quests is a self-hosted application: you (or the person operating the server you use) run the entire system on private infrastructure. There is no central server operated by the developer, no analytics collection, and no advertising. All data that the application processes remains on the server where it is deployed, and the developer has no access to that data unless you choose to share it.',
  },
  {
    title: '2. Data We Collect — None',
    body: 'We do not collect any data related to you. The application runs entirely on your own server: there is no sign-up, no analytics, no trackers, no advertising, and nothing you enter is ever sent to the developer or to any central server. To complete quests on your behalf, the application does process a small amount of Discord information locally on the server where it is deployed — it never leaves that server and is never shared with anyone. This locally processed information includes: (a) the Discord token you provide at login; (b) basic profile details returned by Discord when verifying the token, such as your username, user ID, and avatar; and (c) quest data fetched from Discord, such as quest names, game names, progress, and reward information. No email address, phone number, payment information, or message content is ever collected or stored.',
  },
  {
    title: '3. How We Use Information',
    body: 'Your token is used exclusively to authenticate API requests to Discord on your behalf — fetching your available quests, accepting them when needed, and sending the activity signals required to register progress. Your profile details are used only to display your account in the interface. If you enable the automatic mode, the stored token is also used on a recurring schedule to check for new quests and complete them without your involvement. None of this information is used for profiling, marketing, or any purpose unrelated to completing your quests.',
  },
  {
    title: '4. Storage and Security',
    body: 'After login, your token is stored in httpOnly cookies in your browser and is kept in the server\'s memory (and, when automatic mode is enabled, in the server\'s persistent data directory) so that quests can continue running in the background. Cookies expire after seven days or immediately when you log out. Because the application is self-hosted, the physical and logical security of this data depends on the server it runs on. Treat your Discord token like a password: anyone who obtains it can act as your Discord account, so only deploy this application on infrastructure you trust.',
  },
  {
    title: '5. Data Sharing',
    body: 'The application does not sell, rent, trade, or share your personal information with any third party. It integrates with a single external service: the official Discord API. Requests sent to Discord include your token and are limited to quest-related operations on your own account. No other outbound connections are made, and there is no telemetry, error reporting, or usage tracking built into the application. Server logs generated during operation remain on your own server.',
  },
  {
    title: '6. Data Retention',
    body: 'Your token remains stored for as long as you stay logged in, up to a maximum of seven days per session, after which you must log in again. Logging out immediately clears the cookies in your browser and the active session on the server. If automatic mode is enabled, the schedule state — which includes the stored token so recurring checks can run — is kept in the server\'s data directory until you turn the feature off. You can remove all persistent data at any time by disabling automatic mode, logging out, or clearing the application\'s data directory.',
  },
  {
    title: '7. Your Choices',
    body: 'You are always in control of your data. You can log out at any time from the account menu, which clears your session credentials. You can enable or disable automatic mode with a single toggle, which stops all background processing. If you operate your own deployment, you can inspect, export, or delete all stored data directly from the server, since nothing is synchronized anywhere else. If you are using a deployment operated by someone else, contact that operator directly about their data practices.',
  },
  {
    title: '8. Children\'s Privacy',
    body: 'The service is not directed at children under the age of 13, which is also the minimum age for a Discord account under Discord\'s own terms. We do not knowingly collect personal information from anyone under 13. If we become aware that a child under 13 has provided a token or used the service, we will take steps to remove that information where it is within our technical reach. Parents and guardians who believe their child has used the service are encouraged to log the child out and clear the application\'s stored data.',
  },
  {
    title: '9. Changes to This Policy',
    body: 'We may update this Privacy Policy from time to time to reflect changes in the application or for legal, operational, or regulatory reasons. When changes are made, the "last updated" date at the top of this page will be revised. Because the application is self-hosted, each deployment displays the policy version that ships with its own release. Continued use of the service after an update constitutes acceptance of the revised policy.',
  },
  {
    title: '10. Contact',
    body: 'If you have questions about this Privacy Policy or about how the application handles your data, you can reach out through the developer\'s website at deadlock.ophelia.website. Please describe your question in detail so it can be answered accurately. Since the application collects almost no data, most privacy concerns can also be resolved directly by logging out and clearing the data directory on your server.',
  },
]

export default function PrivacyPage() {
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
        <h1 className="text-2xl font-semibold">Privacy Policy</h1>
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
