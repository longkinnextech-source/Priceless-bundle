import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import LoginForm from "@/components/forms/LoginForm";
import { currentUser } from "@/lib/auth";
import { Skeleton } from "@/components/ui";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Priceless Bundle wallet.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await currentUser();
  if (session) redirect(session.admin ? "/admin" : "/buy");
  const { next } = await searchParams;

  return (
    <Suspense fallback={<Skeleton className="mx-auto h-80 max-w-md" />}>
      <LoginForm nextPath={next} />
    </Suspense>
  );
}
