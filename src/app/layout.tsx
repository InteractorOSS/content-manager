import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { auth } from "@/lib/auth";
import { env } from "@/lib/env";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "Interactor CMS",
    template: "%s | Interactor CMS",
  },
  description: "Content Management System for Interactor",
  robots: "noindex, nofollow",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en">
      <body className={inter.className}>
        <Providers>{children}</Providers>
        {env.BUILD_FEEDBACK_PROJECT_ID && env.BUILD_FEEDBACK_EMBED_TOKEN && (
          <script
            src={`${env.BUILD_FEEDBACK_API_BASE}/feedback-widget.js`}
            data-project-id={env.BUILD_FEEDBACK_PROJECT_ID}
            data-embed-token={env.BUILD_FEEDBACK_EMBED_TOKEN}
            data-api-base={env.BUILD_FEEDBACK_API_BASE}
            data-surfaces="feedback,bug,idea"
            {...(session?.user?.id ? { "data-user-ref": session.user.id } : {})}
          />
        )}
      </body>
    </html>
  );
}
