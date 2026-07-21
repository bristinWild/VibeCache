export function createServerSupabaseClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'fixture-user' } } }),
    },
  };
}
