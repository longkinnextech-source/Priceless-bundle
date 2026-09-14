export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="skeleton h-9 w-56 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <div className="skeleton h-24 rounded-2xl" />
          <div className="skeleton h-56 rounded-2xl" />
        </div>
        <div className="space-y-4">
          <div className="skeleton h-36 rounded-2xl" />
          <div className="skeleton h-64 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
