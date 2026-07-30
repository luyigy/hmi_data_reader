import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Start seeding...');

  await prisma.task.deleteMany();
  await prisma.agent.deleteMany();
  await prisma.gateway.deleteMany();

  const gateways = await prisma.gateway.createMany({
    data: [
      {
        name: 'Local Gateway',
        ip: '127.0.0.1',
        status: 'online',
        resources: JSON.stringify({ cpu: 32, memory: 64, disk: 512 }),
      },
      {
        name: 'Remote Gateway A',
        ip: '10.0.8.12',
        status: 'online',
        resources: JSON.stringify({ cpu: 16, memory: 32, disk: 256 }),
      },
      {
        name: 'Remote Gateway B',
        ip: '10.0.8.21',
        status: 'offline',
        resources: JSON.stringify({ cpu: 8, memory: 16, disk: 128 }),
      },
    ],
  });

  console.log('Gateways created:', gateways.count);
  console.log('Seeding finished.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
