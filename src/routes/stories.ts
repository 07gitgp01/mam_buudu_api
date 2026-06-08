import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireEdit } from '../middleware/auth';
import { AuthRequest } from '../types';
import { notifyFamille, notifyUser } from '../lib/notifications';

const router = Router();
router.use(requireAuth);

// ── Schémas de validation ────────────────────────────────────────────────────

const createStorySchema = z.object({
  titre:     z.string().max(200).optional().nullable(),
  caption:   z.string().min(1).max(5000),
  tag:       z.string().max(50).optional().nullable(),
  mediaUrl:  z.string().url().optional().nullable(),
  mediaType: z.enum(['photo', 'video', 'text', 'audio']).optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(), // ISO string, null = permanent
  privacy:   z.enum(['family', 'custom', 'private']).default('family'),
});

const reactSchema = z.object({
  emoji: z.string().default('❤️'),
});

const commentSchema = z.object({
  content:  z.string().min(1).max(2000),
  parentId: z.string().uuid().optional().nullable(),
});

// ── Helper : shape de réponse story ─────────────────────────────────────────

function shapeStory(story: any, currentUserId: string) {
  const myReaction = story.reactions?.find((r: any) => r.userId === currentUserId);
  const reactionCounts: Record<string, number> = {};
  for (const r of story.reactions ?? []) {
    reactionCounts[r.emoji] = (reactionCounts[r.emoji] ?? 0) + 1;
  }

  return {
    id:              story.id,
    titre:           story.titre,
    caption:         story.caption,
    tag:             story.tag,
    mediaUrl:        story.mediaUrl,
    mediaType:       story.mediaType,
    expiresAt:       story.expiresAt?.toISOString() ?? null,
    privacy:         story.privacy,
    viewCount:       story.viewCount,
    createdAt:       story.createdAt.toISOString(),
    updatedAt:       story.updatedAt.toISOString(),
    // Auteur
    auteurId:        story.creator.id,
    auteurNom:       story.creator.nom,
    auteurPrenom:    story.creator.prenom,
    auteurSexe:      story.creatorPersonne?.sexe ?? null,
    auteurAvatar:    story.creatorPersonne?.photoUrl ?? null,
    // Social
    likesCount:        reactionCounts['❤️'] ?? 0,
    commentairesCount: story._count?.comments ?? 0,
    isLikedByMe:       !!myReaction && myReaction.emoji === '❤️',
    myReactionEmoji:   myReaction?.emoji ?? null,
    reactions:         reactionCounts,
    isViewedByMe:      story.views?.some((v: any) => v.userId === currentUserId) ?? false,
  };
}

// ── GET /api/stories ─────────────────────────────────────────────────────────

router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const stories = await prisma.story.findMany({
      where: {
        familleId: req.user!.familleId,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: {
        creator: { select: { id: true, nom: true, prenom: true } },
        reactions: { select: { userId: true, emoji: true } },
        views:     { select: { userId: true } },
        _count:    { select: { comments: true } },
      },
    });

    // Chercher le sexe + avatar depuis FamilleMembre → Personne
    const creatorIds = [...new Set(stories.map(s => s.creatorId))];
    const membres = await prisma.familleMembre.findMany({
      where: { userId: { in: creatorIds }, familleId: req.user!.familleId },
      include: { personne: { select: { sexe: true, photoUrl: true } } },
    });
    const personneByUser = Object.fromEntries(
      membres.filter(m => m.personne).map(m => [m.userId, m.personne])
    );

    const shaped = stories.map(s => shapeStory(
      { ...s, creatorPersonne: personneByUser[s.creatorId] ?? null },
      req.user!.id
    ));

    res.json(shaped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/stories ────────────────────────────────────────────────────────

router.post('/', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = createStorySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Données invalides', details: parse.error.errors });
    return;
  }

  try {
    const { titre, caption, tag, mediaUrl, mediaType, expiresAt, privacy } = parse.data;

    const story = await prisma.story.create({
      data: {
        familleId: req.user!.familleId,
        creatorId: req.user!.id,
        titre:     titre ?? null,
        caption,
        tag:       tag ?? null,
        mediaUrl:  mediaUrl ?? null,
        mediaType: mediaType ?? (mediaUrl ? 'photo' : 'text'),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        privacy,
      },
      include: {
        creator:   { select: { id: true, nom: true, prenom: true } },
        reactions: { select: { userId: true, emoji: true } },
        views:     { select: { userId: true } },
        _count:    { select: { comments: true } },
      },
    });

    // Récupérer les infos personne du créateur
    const membre = await prisma.familleMembre.findUnique({
      where: { familleId_userId: { familleId: req.user!.familleId, userId: req.user!.id } },
      include: { personne: { select: { sexe: true, photoUrl: true } } },
    });

    res.status(201).json(shapeStory(
      { ...story, creatorPersonne: membre?.personne ?? null },
      req.user!.id
    ));

    // Notifier tous les membres sauf l'auteur
    const auteur = `${story.creator.prenom} ${story.creator.nom}`;
    notifyFamille(req.user!.familleId, req.user!.id, {
      type:    'nouvelle_story',
      titre:   `Nouvelle story de ${auteur}`,
      message: story.titre ? `"${story.titre}" — ${story.caption.slice(0, 80)}` : story.caption.slice(0, 100),
      data:    { storyId: story.id, auteur, tag: story.tag ?? null },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /api/stories/:id ──────────────────────────────────────────────────

router.delete('/:id', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const story = await prisma.story.findFirst({
      where: { id: req.params.id, familleId: req.user!.familleId },
    });
    if (!story) {
      res.status(404).json({ error: 'Story introuvable' });
      return;
    }
    if (story.creatorId !== req.user!.id) {
      res.status(403).json({ error: 'Vous ne pouvez supprimer que vos propres stories' });
      return;
    }
    await prisma.story.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/stories/:id/react ──────────────────────────────────────────────

router.post('/:id/react', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = reactSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Emoji invalide' });
    return;
  }
  try {
    await prisma.storyReaction.upsert({
      where: { storyId_userId: { storyId: req.params.id, userId: req.user!.id } },
      create: { storyId: req.params.id, userId: req.user!.id, emoji: parse.data.emoji },
      update: { emoji: parse.data.emoji },
    });
    res.status(204).send();

    // Notifier l'auteur de la story (sauf si c'est lui qui réagit)
    const story = await prisma.story.findUnique({
      where: { id: req.params.id },
      select: { creatorId: true, familleId: true, titre: true, caption: true },
    });
    if (story && story.creatorId !== req.user!.id) {
      const reactor = await prisma.user.findUnique({
        where: { id: req.user!.id }, select: { nom: true, prenom: true },
      });
      const nom = reactor ? `${reactor.prenom} ${reactor.nom}` : 'Quelqu\'un';
      notifyUser(story.creatorId, story.familleId, {
        type:    'reaction_story',
        titre:   `${nom} a réagi à votre story`,
        message: `${parse.data.emoji} sur "${story.titre ?? story.caption.slice(0, 50)}"`,
        data:    { storyId: req.params.id, emoji: parse.data.emoji },
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /api/stories/:id/react ────────────────────────────────────────────

router.delete('/:id/react', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await prisma.storyReaction.deleteMany({
      where: { storyId: req.params.id, userId: req.user!.id },
    });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/stories/:id/view ───────────────────────────────────────────────

router.post('/:id/view', async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.isViewonly) { res.status(204).send(); return; }
  try {
    await prisma.$transaction([
      prisma.storyView.upsert({
        where: { storyId_userId: { storyId: req.params.id, userId: req.user!.id } },
        create: { storyId: req.params.id, userId: req.user!.id },
        update: {},
      }),
      prisma.story.update({
        where: { id: req.params.id },
        data: { viewCount: { increment: 1 } },
      }),
    ]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(204).send(); // ne pas bloquer l'UI
  }
});

// ── GET /api/stories/:id/comments ────────────────────────────────────────────

router.get('/:id/comments', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const comments = await prisma.storyComment.findMany({
      where: { storyId: req.params.id, parentId: null },
      orderBy: { createdAt: 'asc' },
      include: {
        user:    { select: { id: true, nom: true, prenom: true } },
        replies: {
          include: { user: { select: { id: true, nom: true, prenom: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    res.json(comments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /api/stories/:id/comments ───────────────────────────────────────────

router.post('/:id/comments', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  const parse = commentSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'Commentaire invalide' });
    return;
  }
  try {
    const comment = await prisma.storyComment.create({
      data: {
        storyId:  req.params.id,
        userId:   req.user!.id,
        content:  parse.data.content,
        parentId: parse.data.parentId ?? null,
      },
      include: { user: { select: { id: true, nom: true, prenom: true } } },
    });
    res.status(201).json(comment);

    // Notifier l'auteur de la story (sauf si c'est lui qui commente)
    const story = await prisma.story.findUnique({
      where: { id: req.params.id },
      select: { creatorId: true, familleId: true, titre: true, caption: true },
    });
    if (story && story.creatorId !== req.user!.id) {
      const nom = `${comment.user.prenom} ${comment.user.nom}`;
      notifyUser(story.creatorId, story.familleId, {
        type:    'commentaire_story',
        titre:   `${nom} a commenté votre story`,
        message: parse.data.content.slice(0, 100),
        data:    { storyId: req.params.id, commentId: comment.id },
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── DELETE /api/stories/:id/comments/:commentId ──────────────────────────────

router.delete('/:id/comments/:commentId', requireEdit, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const comment = await prisma.storyComment.findFirst({
      where: { id: req.params.commentId, storyId: req.params.id },
    });
    if (!comment) {
      res.status(404).json({ error: 'Commentaire introuvable' });
      return;
    }
    if (comment.userId !== req.user!.id) {
      res.status(403).json({ error: 'Vous ne pouvez supprimer que vos commentaires' });
      return;
    }
    await prisma.storyComment.delete({ where: { id: req.params.commentId } });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
