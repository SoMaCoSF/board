import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistMono } from "geist/font/mono";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "software factory", template: "%s · software factory" },
  description: "A board, an agent, and a sandbox that take your team's bugs, features, and questions to pull requests.",
};

export const viewport: Viewport = { colorScheme: "light dark" };

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" className={GeistMono.variable}>
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
