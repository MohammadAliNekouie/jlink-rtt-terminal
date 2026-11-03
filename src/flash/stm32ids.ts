/** STM32 families that are recognised (for a helpful message) but have no flash driver yet. */
export const UNSUPPORTED_STM32: Record<number, string> = {
  0x449: 'STM32F7', 0x451: 'STM32F7', 0x452: 'STM32F7',
  0x415: 'STM32L4', 0x435: 'STM32L4', 0x461: 'STM32L4', 0x462: 'STM32L4', 0x464: 'STM32L4',
  0x470: 'STM32L4+', 0x471: 'STM32L4+',
  0x460: 'STM32G0', 0x466: 'STM32G0', 0x467: 'STM32G0',
  0x468: 'STM32G4', 0x469: 'STM32G4', 0x479: 'STM32G4',
  0x450: 'STM32H7', 0x480: 'STM32H7', 0x483: 'STM32H7',
  0x417: 'STM32L0', 0x425: 'STM32L0', 0x447: 'STM32L0', 0x457: 'STM32L0',
  0x416: 'STM32L1', 0x429: 'STM32L1', 0x427: 'STM32L1', 0x436: 'STM32L1', 0x437: 'STM32L1',
  0x495: 'STM32WB', 0x472: 'STM32L5',
};
