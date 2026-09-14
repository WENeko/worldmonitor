import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetSocialVelocityRequest,
  GetSocialVelocityResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { normalizeSocialVelocity } from '../../../../api/_social-velocity.js';

const REDIS_KEY = 'intelligence:social:reddit:v1';
export const getSocialVelocity: IntelligenceServiceHandler['getSocialVelocity'] = async (
  _ctx: ServerContext,
  _req: GetSocialVelocityRequest,
): Promise<GetSocialVelocityResponse> => {
  const data = await getCachedJson(REDIS_KEY, true);
  return normalizeSocialVelocity(data);
};
