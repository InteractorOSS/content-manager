"use client";

import dynamic from "next/dynamic";

// Reads the URL fragment and sessionStorage, so it renders client-only.
export const PostListLoader = dynamic(() => import("./post-list").then((m) => m.PostList), { ssr: false });
