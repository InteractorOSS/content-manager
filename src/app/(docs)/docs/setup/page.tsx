import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: { absolute: "Setup | Interactor CMS Docs" },
  description:
    "Get started with Interactor CMS: sign in with your Interactor account, set up your organization and sites, invite your team, and write your first post.",
};

const code = "rounded bg-muted px-1 py-0.5";
const ui = "text-foreground";

export default function DocsSetupPage() {
  return (
    <article className="space-y-10">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold text-foreground">Setup</h1>
        <p className="text-muted-foreground">
          From a first sign-in to a published post, in five steps. Everything here happens in the
          CMS itself; no code is needed.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">1. Sign in</h2>
        <p className="text-sm text-muted-foreground">
          Go to <Link href="/login" className="underline">Sign in</Link>. You sign in with your
          Interactor account, the same one you use across Interactor. If you don&apos;t have one,
          you can create it there.
        </p>
        <p className="text-sm text-muted-foreground">
          If you were invited to an organization, sign in with the email address the invitation
          was sent to: you join that organization with the role you were invited as. If nobody
          invited you, the CMS creates an organization of your own on your first sign-in, with you
          as its owner.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          2. Check your organization
        </h2>
        <p className="text-sm text-muted-foreground">
          An organization holds everything: posts, categories, media, FAQs, members and sites. Its
          name and settings are under <span className={ui}>Settings → Organization</span>{" "}
          (owners and admins can edit them). If you belong to several organizations, the organization
          switcher in the sidebar chooses which one you&apos;re working in.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">3. Register your sites</h2>
        <p className="text-sm text-muted-foreground">
          A site is somewhere your posts appear: your main website, a product&apos;s blog, a
          newsletter. Each post chooses which sites it goes to. Add them under{" "}
          <span className={ui}>Settings → Sites</span>, each with a short slug and its base URL
          (for example <code className={code}>https://example.com/blog</code>).
        </p>
        <p className="text-sm text-muted-foreground">
          A new organization starts with one site called <code className={code}>website</code>{" "}
          whose URL is a placeholder. Rename it and set its real URL: the URL is what each
          site&apos;s RSS feed and sitemap link to.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">4. Invite your team</h2>
        <p className="text-sm text-muted-foreground">
          Under <span className={ui}>Members</span>, choose <span className={ui}>Invite user</span>, enter their email and pick a role.
          The role applies when they first sign in with that address.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            <span className={ui}>Authors</span>{" "}write drafts and submit them for review.
          </li>
          <li>
            <span className={ui}>Reviewers and editors</span>{" "}approve or reject submitted posts
            in the <span className={ui}>Review</span>{" "}queue.
          </li>
          <li>
            <span className={ui}>Admins and the owner</span>{" "}also publish directly, manage
            members and change settings.
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          The exact permissions behind each role are listed in{" "}
          <Link href="/docs/auth" className="underline">Authentication</Link>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-foreground border-b pb-2">
          5. Write and publish a post
        </h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            Open <span className={ui}>Posts</span>{" "}and start a <span className={ui}>New Post</span>, write it, and choose its sites,
            category and tags.
          </li>
          <li>
            <span className={ui}>Save Draft</span>, then <span className={ui}>Submit for review</span>. If your role
            can publish, you can <span className={ui}>Publish</span>{" "}directly instead.
          </li>
          <li>
            Once published, the post appears on each site it targets, through the public API and
            that site&apos;s RSS feed.
          </li>
        </ol>
        <p className="text-sm text-muted-foreground">
          A post with no featured image gets a generated title card when it&apos;s published, and
          deleting a post moves it to the trash for 30 days.
        </p>
      </section>

      <section className="space-y-3 border-t pt-6">
        <h2 className="text-xl font-semibold text-foreground">Next</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            <Link href="/docs/claude-desktop" className="underline">Claude desktop</Link>: write
            and edit posts from Claude.
          </li>
          <li>
            <Link href="/docs/api" className="underline">API</Link>: show posts on your own site,
            or manage content from your own scripts.
          </li>
        </ul>
      </section>
    </article>
  );
}
