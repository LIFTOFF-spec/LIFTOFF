import { PageContainer } from "@/components/ui/primitives";
import { Skeleton } from "@/components/ui/states";

export default function Loading() {
  return (
    <PageContainer className="flex flex-col gap-6">
      <Skeleton className="h-12 w-72" />
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-[118px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </PageContainer>
  );
}
