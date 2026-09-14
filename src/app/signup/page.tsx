import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import SignupForm from "@/components/forms/SignupForm";
import { currentUser } from "@/lib/auth";
import { Skeleton } from "@/components/ui";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Join Priceless Bundle — buy and resell MTN, Telecel and AirtelTigo data in Ghana.",
};

export default async function SignupPage() {
  const session = await currentUser();
  if (session) redirect(session.admin ? "/admin" : "/buy");

  return (
    <Suspense fallback={<Skeleton className="mx-auto h-96 max-w-lg" />}>
      <SignupForm />
    </Suspense>
  );
}
