import { createBffProxy } from '@jiwar/bff';
import { managerBff } from '@/lib/bff';

export const dynamic = 'force-dynamic';

export const { GET, POST, PUT, PATCH, DELETE } = createBffProxy(managerBff);
