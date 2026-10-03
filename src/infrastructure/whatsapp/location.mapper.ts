import type { proto } from '@whiskeysockets/baileys';
import type { NativeLocation } from '../../modules/messaging/native-location.js';

function label(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : undefined;
}

/** Protobuf defaults are inherited: an absent coordinate must not silently become zero. */
export function mapNativeLocation(content: proto.IMessage): NativeLocation | undefined {
  const pin = content.locationMessage ?? content.liveLocationMessage;
  if (!pin || !Object.hasOwn(pin, 'degreesLatitude') || !Object.hasOwn(pin, 'degreesLongitude'))
    return undefined;
  const latitude = pin.degreesLatitude;
  const longitude = pin.degreesLongitude;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return undefined;
  const initial = content.locationMessage;
  const name = label(initial?.name, 256);
  const address = label(initial?.address, 1024);
  const caption = label(initial?.comment ?? content.liveLocationMessage?.caption, 1024);
  return {
    latitude,
    longitude,
    kind: !initial || initial.isLive === true ? 'live_snapshot' : 'static',
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(caption ? { caption } : {}),
  };
}
