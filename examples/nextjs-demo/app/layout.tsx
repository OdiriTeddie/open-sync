import type { ReactNode } from "react";

export const metadata = {
  title: "SyncKit Next.js Demo",
  description: "Local-first CRUD demo powered by SyncKit."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
