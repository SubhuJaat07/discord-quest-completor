import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-card">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-2 px-4 py-6 text-center">
        <nav className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Link href="/terms" className="hover:text-foreground">
            Terms of Service
          </Link>
          <span className="text-border">·</span>
          <Link href="/privacy" className="hover:text-foreground">
            Privacy Policy
          </Link>
          <span className="text-border">·</span>
          <a
            href="https://github.com/SubhuJaat07/discord-quest-completor"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground"
          >
            Open source
          </a>
        </nav>
        <p className="text-xs text-muted-foreground">
          Developed by{" "}
          <a
            href="https://deadlock.ophelia.website"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground/80 hover:text-foreground"
          >
            Deadlock studio
          </a>{" "}
          🎙️
        </p>
      </div>
    </footer>
  );
}
