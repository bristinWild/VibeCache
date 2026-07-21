import { prisma } from '../../../lib/prisma';
import { createServerSupabaseClient } from '../../../lib/supabase/server';

export async function GET(): Promise<Response> {
  const supabase = createServerSupabaseClient();
  const { data } = await supabase.auth.getUser();

  if (!data.user) return new Response('Unauthorized', { status: 401 });

  const subscription = await prisma.subscription.findUnique({
    where: { userId: data.user.id },
  });

  return Response.json({ subscription });
}
