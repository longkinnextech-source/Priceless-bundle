import { Button, Card } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <Card>
        <p className="text-5xl">🔥</p>
        <h1 className="mt-4 text-3xl font-extrabold">Page not found</h1>
        <p className="mt-2 text-sm text-ash-400">
          That link doesn&apos;t exist. Let&apos;s get you back to buying data.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button href="/">Back home</Button>
          <Button href="/buy" variant="secondary">
            Buy data
          </Button>
        </div>
      </Card>
    </div>
  );
}
