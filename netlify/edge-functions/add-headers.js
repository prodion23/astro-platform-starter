export default async (request, context) => {
  // --- Add a request header before forwarding to origin ---
  const reqHeaders = new Headers(request.headers)
  reqHeaders.set('x-traceable-edge-in', 'netlify')

  // Clone the original request with modified headers
  const upstreamRequest = new Request(request, {
    headers: reqHeaders,
  })

  // Call the origin (or next handler)
  const upstreamResponse = await fetch(upstreamRequest)

  // --- Add a response header before returning to client ---
  const resHeaders = new Headers(upstreamResponse.headers)
  resHeaders.set('x-traceable-edge-out', 'netlify')

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: resHeaders,
  })
}
