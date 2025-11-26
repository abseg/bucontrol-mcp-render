/**
 * Shared Constants
 * Used across all tools and transports
 */

// Source name mapping
export const SOURCE_NAMES = {
  1: 'Laptop',
  2: 'ClickShare',
  3: 'AppleTV',
  4: 'Conference'
};

export const SOURCE_IDS = {
  'laptop': 1,
  'clickshare': 2,
  'appletv': 3,
  'apple tv': 3,
  'conference': 4,
  'conf': 4
};

// Volume level mapping (dB values)
export const VOLUME_MAP = {
  mute: -100,
  low: -40,
  medium: -20,
  high: 0,
  max: 10
};

export default { SOURCE_NAMES, SOURCE_IDS, VOLUME_MAP };
