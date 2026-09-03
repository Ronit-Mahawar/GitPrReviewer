import Link from "next/link";
import {
  ArrowRight,
  CheckCircle,
  GitPullRequest,
  GitMerge,
  MessageSquare,
  ScanSearch,
  Shield,
  Wand2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
          <Link
            href="/"
            className="font-semibold tracking-tight hover:opacity-80 transition-opacity"
          >
            CodeReviewAI
          </Link>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/sign-up">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 -z-10">
            <div className="absolute left-1/2 top-0 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/[0.03] blur-3xl" />
          </div>

          <div className="mx-auto max-w-2xl px-6 py-24 text-center sm:py-32">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              Ship better code,
              <br />
              <span className="text-gradient">faster</span>
            </h1>

            <p className="mx-auto mt-6 max-w-lg text-muted-foreground leading-relaxed">
              Automated code reviews that catch bugs, security issues, and
              maintainability problems before they reach production.
            </p>

            <div className="mt-10 flex items-center justify-center gap-3">
              <Button size="lg" asChild>
                <Link href="/sign-up">
                  Start for free
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link href="/sign-in">Sign in</Link>
              </Button>
            </div>

            <div className="mt-12 flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-emerald-500" />
                No credit card required
              </span>
              <span className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-emerald-500" />
                GitHub integration
              </span>
              <span className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-emerald-500" />
                Private repos supported
              </span>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="border-t border-border/40">
          <div className="mx-auto max-w-5xl px-6 py-24">
            <div className="text-center">
              <h2 className="text-2xl font-semibold tracking-tight">
                Everything you need for better reviews
              </h2>
              <p className="mt-2 text-muted-foreground">
                Focus on building. Let AI handle the repetitive review work.
              </p>
            </div>

            <div className="mt-16 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: Zap,
                  title: "Instant feedback",
                  description:
                    "Get comprehensive reviews in seconds, not hours.",
                },
                {
                  icon: Shield,
                  title: "Security scanning",
                  description:
                    "Detect vulnerabilities and secrets automatically.",
                },
                {
                  icon: MessageSquare,
                  title: "Clear suggestions",
                  description: "Actionable feedback you can apply immediately.",
                },
                {
                  icon: GitPullRequest,
                  title: "PR integration",
                  description: "Reviews appear right in your pull requests.",
                },
                {
                  icon: ScanSearch,
                  title: "Context aware",
                  description: "Understands your codebase patterns and style.",
                },
                {
                  icon: Wand2,
                  title: "Always improving",
                  description: "Powered by the latest AI models.",
                },
              ].map((feature) => (
                <div key={feature.title} className="group">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/15">
                    <feature.icon className="h-4 w-4 text-primary" />
                  </div>
                  <h3 className="mt-3 font-medium">{feature.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-border/40 bg-muted/30">
          <div className="mx-auto max-w-5xl px-6 py-24">
            <div className="text-center">
              <h2 className="text-2xl font-semibold tracking-tight">
                Up and running in minutes
              </h2>
              <p className="mt-2 text-muted-foreground">
                Three steps to better code reviews.
              </p>
            </div>

            <div className="mt-16 grid gap-8 sm:grid-cols-3">
              {[
                {
                  step: "1",
                  icon: GitPullRequest,
                  title: "Connect GitHub",
                  description: "Sign in and select repositories to enable.",
                },
                {
                  step: "2",
                  icon: ScanSearch,
                  title: "Open a PR",
                  description:
                    "CodeReviewAI triggers automatically on every pull request.",
                },
                {
                  step: "3",
                  icon: GitMerge,
                  title: "Merge with confidence",
                  description: "Address suggestions and ship faster.",
                },
              ].map((item) => (
                <div key={item.step} className="text-center">
                  <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                    <item.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="mt-4 font-medium">{item.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
                    {item.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-border/40">
          <div className="mx-auto max-w-2xl px-6 py-24 text-center">
            <h2 className="text-2xl font-semibold tracking-tight">
              Ready to improve your code reviews?
            </h2>
            <p className="mt-2 text-muted-foreground">
              Start free. Upgrade when your team needs more.
            </p>
            <Button size="lg" className="mt-8" asChild>
              <Link href="/sign-up">
                Get started for free
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6 text-sm text-muted-foreground">
          <span>© 2025 CodeReviewAI</span>
          <div className="flex items-center gap-6">
            <Link
              href="/sign-in"
              className="hover:text-foreground transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="hover:text-foreground transition-colors"
            >
              Get started
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
