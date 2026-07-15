<script lang="ts">
  import Composer from "./Composer.svelte";
</script>

<!-- A deferred new session is the same workspace in an empty state, not a setup
     wizard. Keep the real composer at the centre of the available canvas until
     its first send creates a transcript. -->
<section
  class="new-session"
  data-testid="new-session"
  aria-labelledby="new-session-prompt"
>
  <div class="composition" data-testid="new-session-composition">
    <h1 id="new-session-prompt">What would you like to work on?</h1>
    <Composer />
    <p>Created when you send</p>
  </div>
</section>

<style>
  .new-session {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    overflow-y: auto;
    box-sizing: border-box;
    /* A little more space below than above places the composition around 43%
       of the usable canvas. The bounded padding yields first when a keyboard
       or an expanded draft makes the viewport short. */
    padding-block: 16px clamp(28px, 16vh, 180px);
  }

  .composition {
    width: 100%;
    min-width: 0;
    max-height: 100%;
  }

  /* Composer's expansion cap is window-based because that is correct for the
     normal transcript layout. A centred draft also has a heading, helper, and
     potentially a software keyboard to share the canvas with, so add the
     tighter contextual cap here. */
  .new-session :global(.composer-wrap textarea) {
    max-height: clamp(
      80px,
      calc(100dvh - var(--keyboard-inset, 0px) - 320px),
      var(--composer-max, 168px)
    );
  }

  h1,
  p {
    width: min(calc(100% - 88px), var(--maxw));
    margin-inline: auto;
  }

  h1 {
    margin-block: 0 14px;
    color: var(--text-muted);
    font-size: 18px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.012em;
  }

  p {
    margin-block: -7px 0;
    color: var(--text-faint);
    font-size: 12px;
    line-height: 1.4;
  }

  @media (max-width: 859px) {
    .new-session {
      padding-block: 12px clamp(20px, 10vh, 72px);
    }

    h1,
    p {
      width: min(calc(100% - 32px), var(--maxw));
    }

    h1 {
      margin-bottom: 10px;
      font-size: 17px;
    }
  }

</style>
