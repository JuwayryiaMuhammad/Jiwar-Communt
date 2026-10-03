import { createBffProxy } from '@jiwar/bff';
import { adminBff } from '@/lib/bff';

export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, PATCH, DELETE } = createBffProxy(adminBff);
