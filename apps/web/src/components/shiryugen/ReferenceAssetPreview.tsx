import { ImageIcon } from "lucide-react";

import { useAssetUrl } from "../../assets/assetUrls";
import type { ShiryuGenReferenceAsset } from "../../shiryuGenProductionStore";

export function ReferenceAssetPreview({
  asset,
  className,
}: {
  asset: ShiryuGenReferenceAsset;
  className: string;
}) {
  if (
    asset.sourceKind === "chat-attachment" &&
    asset.environmentId !== undefined &&
    asset.attachmentId
  ) {
    return (
      <ChatAttachmentReferencePreview
        asset={asset}
        environmentId={asset.environmentId}
        attachmentId={asset.attachmentId}
        className={className}
      />
    );
  }
  if (!asset.source) {
    return <ReferenceAssetFallback className={className} />;
  }
  return <img src={asset.source} alt={asset.name} className={className} />;
}

function ChatAttachmentReferencePreview({
  asset,
  environmentId,
  attachmentId,
  className,
}: {
  asset: ShiryuGenReferenceAsset;
  environmentId: NonNullable<ShiryuGenReferenceAsset["environmentId"]>;
  attachmentId: string;
  className: string;
}) {
  const resolvedUrl = useAssetUrl(environmentId, {
    _tag: "attachment",
    attachmentId,
  });
  const source = resolvedUrl ?? asset.source;
  return source ? (
    <img src={source} alt={asset.name} className={className} />
  ) : (
    <ReferenceAssetFallback className={className} />
  );
}

function ReferenceAssetFallback({ className }: { className: string }) {
  return (
    <div
      className={`${className} flex items-center justify-center bg-muted/35 text-muted-foreground`}
    >
      <ImageIcon className="size-4" />
    </div>
  );
}
