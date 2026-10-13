import type { MockScenario, RiskLevel } from '../types';

export function mockRiskPayload(scenario: MockScenario): { level: RiskLevel; details: Record<string, unknown> } {
  switch (scenario) {
    case 'low':
      return {
        level: 'LOW',
        details: {
          newDevice: { level: 'LOW', reason: 'Device has been seen before.' },
          city: 'Austin',
          country: 'United States',
        },
      };
    case 'new_device':
      return {
        level: 'MEDIUM',
        details: {
          newDevice: { level: 'HIGH', reason: 'This device has not been seen for this user.' },
          device: { id: 'device-new', lastSeen: null },
        },
      };
    case 'anomalous_location':
      return {
        level: 'MEDIUM',
        details: {
          userLocationAnomaly: { level: 'HIGH', reason: 'Unusual country for this user.' },
          city: 'Berlin',
          country: 'Germany',
        },
      };
    case 'impossible_travel':
      return {
        level: 'HIGH',
        details: {
          impossibleTravel: true,
          estimatedSpeed: 2400,
          estimatedDistance: 8_000_000,
          city: 'Singapore',
          country: 'Singapore',
        },
      };
    case 'bot':
      return {
        level: 'HIGH',
        details: {
          botDetection: { level: 'HIGH', reason: 'Automated client signals.' },
          detected: { rule: { id: 12 } },
        },
      };
  }
}
