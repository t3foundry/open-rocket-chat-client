import { useTranslation } from 'react-i18next';

import { Icons } from '@/ui/icon';

/**
 * A small lock icon that marks an encrypted Tasra channel, with the slot id
 * shown as a tooltip so the user can confirm which slot is in use.
 *
 * Styled to match the existing header metadata — muted, small, out of the flow
 * until a room carries the marker.
 */
export const TasraBadge = ({ slotId }: { slotId: `0x${string}` }) => {
  const { t } = useTranslation('rooms');

  return (
    <span
      title={t('tasra.encryptedChannel', { slotId })}
      aria-label={t('tasra.encryptedChannel', { slotId })}
      className="text-content-muted shrink-0"
    >
      <Icons.private size={16} />
    </span>
  );
};
