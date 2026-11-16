# Assets

Files in `assets/logos/` are named by gym_id (for example `G001.png`) and served through jsDelivr:

    https://cdn.jsdelivr.net/gh/<owner>/<repo>@<tag>/assets/logos/<gym_id>.png

To change a logo, replace the file with one of the same name, push, and cut a new tag. Then point the URLs at the new tag.

Full-size originals stay out of git (`assets/logos-original/` is ignored).
